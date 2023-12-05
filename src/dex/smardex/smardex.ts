import { AbiCoder, Interface } from '@ethersproject/abi';
import { Contract } from 'web3-eth-contract';
import _ from 'lodash';
import {
  DEST_TOKEN_PARASWAP_TRANSFERS,
  ETHER_ADDRESS,
  NULL_ADDRESS,
  Network,
  SRC_TOKEN_PARASWAP_TRANSFERS,
  SwapSide,
} from '../../constants';
import {
  AdapterExchangeParam,
  Address,
  ExchangePrices,
  Logger,
  NumberAsString,
  PoolLiquidity,
  PoolPrices,
  SimpleExchangeParam,
  Token,
  TransferFeeParams,
  TxInfo,
} from '../../types';
import { IDexHelper } from '../../dex-helper/index';
import {
  SmardexFees,
  SmardexPair,
  SmardexPool,
  SmardexPoolOrderedParams,
  SmardexPoolState,
} from './types';
import { getBigIntPow, getDexKeysWithNetwork, isETHAddress } from '../../utils';
import SmardexFactoryLayerOneABI from '../../abi/smardex/layer-1/smardex-factory.json';
import SmardexFactoryLayerTwoABI from '../../abi/smardex/layer-2/smardex-factory.json';

import SmardexRouterABI from '../../abi/smardex/all/smardex-router.json';
import { SimpleExchange } from '../simple-exchange';
import {
  SmardexRouterFunctions,
  directSmardexFunctionName,
  DefaultSmardexPoolGasCost,
  SUBGRAPH_TIMEOUT,
  FEES_LAYER_ONE,
} from '../smardex/constants';
import { SmardexData, SmardexParam } from '../smardex/types';
import { IDex } from '../..';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { Adapters, SmardexConfig } from './config';
import ParaSwapABI from '../../abi/IParaswap.json';
import { applyTransferFee } from '../../lib/token-transfer-fee';
import { computeAmountIn, computeAmountOut } from './sdk/core';
import { SmardexEventPool } from './smardex-event-pool';
import SmardexPoolLayerOneABI from '../../abi/smardex/layer-1/smardex-pool.json';
import SmardexPoolLayerTwoABI from '../../abi/smardex/layer-2/smardex-pool.json';

const smardexPoolL1 = new Interface(SmardexPoolLayerOneABI);
const smardexPoolL2 = new Interface(SmardexPoolLayerTwoABI);

const coder = new AbiCoder();

function encodePools(
  pools: SmardexPool[],
  // feeFactor: number,
): NumberAsString[] {
  return pools.map(({ fee, direction, address }) => {
    return (
      (BigInt(fee) << 161n) +
      ((direction ? 0n : 1n) << 160n) +
      BigInt(address)
    ).toString();
  });
}

export class Smardex
  extends SimpleExchange
  implements IDex<SmardexData, SmardexParam>
{
  pairs: { [key: string]: SmardexPair } = {};
  factory: Contract;

  routerInterface: Interface;
  exchangeRouterInterface: Interface;
  static directFunctionName = directSmardexFunctionName;

  factoryAddress: string;
  routerAddress: string;

  protected subgraphURL: string | undefined;
  protected initCode: string;

  logger: Logger;
  readonly hasConstantPriceLargeAmounts = false;
  readonly isFeeOnTransferSupported: boolean = true;
  readonly SRC_TOKEN_DEX_TRANSFERS = 1;
  readonly DEST_TOKEN_DEX_TRANSFERS = 1;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(SmardexConfig);

  constructor(
    protected network: Network,
    dexKey: string,
    public dexHelper: IDexHelper,
    protected adapters = Adapters[network] || {},
  ) {
    super(dexHelper, dexKey);
    this.logger = dexHelper.getLogger(dexKey);
    const config = SmardexConfig[dexKey];
    this.routerAddress = config[network].router!;
    this.factoryAddress = config[network].factoryAddress;
    this.subgraphURL = config[network].subgraphURL;
    this.initCode = config[network].initCode;
    const factoryAbi = this.isLayer1()
      ? SmardexFactoryLayerOneABI
      : SmardexFactoryLayerTwoABI;
    this.factory = new dexHelper.web3Provider.eth.Contract(
      factoryAbi as any,
      this.factoryAddress,
    );
    this.routerInterface = new Interface(ParaSwapABI);
    this.exchangeRouterInterface = new Interface(SmardexRouterABI);
  }

  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return this.adapters[side] ? this.adapters[side] : null;
  }

  async getPoolIdentifiers(
    _from: Token,
    _to: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    const from = this.dexHelper.config.wrapETH(_from);
    const to = this.dexHelper.config.wrapETH(_to);

    if (from.address.toLowerCase() === to.address.toLowerCase()) {
      return [];
    }

    const tokenAddress = [from.address.toLowerCase(), to.address.toLowerCase()]
      .sort((a, b) => (BigInt(a) > BigInt(b) ? 1 : -1))
      .join('_');

    const poolIdentifier = `${this.dexKey}_${tokenAddress}`;
    return [poolIdentifier];
  }

  async getPricesVolume(
    _from: Token,
    _to: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    // list of pool identifiers to use for pricing, if undefined use all pools
    limitPools?: string[],
    transferFees: TransferFeeParams = {
      srcFee: 0,
      destFee: 0,
      srcDexFee: 0,
      destDexFee: 0,
    },
  ): Promise<ExchangePrices<SmardexData> | null> {
    try {
      const from = this.dexHelper.config.wrapETH(_from);
      const to = this.dexHelper.config.wrapETH(_to);

      if (from.address.toLowerCase() === to.address.toLowerCase()) {
        return null;
      }

      const tokenAddress = [
        from.address.toLowerCase(),
        to.address.toLowerCase(),
      ]
        .sort((a, b) => (BigInt(a) > BigInt(b) ? 1 : -1))
        .join('_');

      const poolIdentifier = `${this.dexKey}_${tokenAddress}`;

      if (limitPools && limitPools.every(p => p !== poolIdentifier))
        return null;

      await this.batchCatchUpPairs([[from, to]], blockNumber);
      const isSell = side === SwapSide.SELL;
      const pairParam = await this.getPairOrderedParams(
        from,
        to,
        blockNumber,
        transferFees.srcDexFee,
      );

      if (!pairParam) return null;

      const unitAmount = getBigIntPow(isSell ? from.decimals : to.decimals);

      // SmarDex does not support Fees on Transfer Tokens
      const [unitVolumeWithFee, ...amountsWithFee] = applyTransferFee(
        [unitAmount, ...amounts],
        side,
        isSell ? transferFees.srcFee : transferFees.destFee,
        isSell ? SRC_TOKEN_PARASWAP_TRANSFERS : DEST_TOKEN_PARASWAP_TRANSFERS,
      );

      const unit = isSell
        ? await this.getSellPricePath(unitVolumeWithFee, [pairParam])
        : await this.getBuyPricePath(unitVolumeWithFee, [pairParam]);

      const prices = isSell
        ? await Promise.all(
            amountsWithFee.map(amount =>
              this.getSellPricePath(amount, [pairParam]),
            ),
          )
        : await Promise.all(
            amountsWithFee.map(amount =>
              this.getBuyPricePath(amount, [pairParam]),
            ),
          );

      const [unitOutWithFee, ...outputsWithFee] = applyTransferFee(
        [unit, ...prices],
        side,
        // This part is confusing, because we treat differently SELL and BUY fees
        // If Buy, we should apply transfer fee on srcToken on top of dexFee applied earlier
        // But for Sell we should apply only one dexFee
        isSell ? transferFees.destDexFee : transferFees.srcFee,
        isSell ? this.DEST_TOKEN_DEX_TRANSFERS : SRC_TOKEN_PARASWAP_TRANSFERS,
      );

      // As uniswapv2 just has one pool per token pair
      return [
        {
          prices: outputsWithFee,
          unit: unitOutWithFee,
          data: {
            deadline: Math.floor(new Date().getTime()) + 120,
            receiver: this.augustusAddress,
            router: this.routerAddress,
            path: [from.address.toLowerCase(), to.address.toLowerCase()],
            factory: this.factoryAddress,
            initCode: this.initCode,
            // feeFactor: this.feeFactor,
            pools: [
              {
                address: pairParam.exchange,
                fee: 0, // Smardex does not support Fees on Transfer Tokens
                direction:
                  pairParam.fromToken.toLocaleLowerCase() ===
                  pairParam.token0.toLocaleLowerCase(),
              },
            ],
          },
          exchange: this.dexKey,
          poolIdentifier,
          gasCost: DefaultSmardexPoolGasCost,
          poolAddresses: [pairParam.exchange],
        },
      ];
    } catch (e) {
      if (blockNumber === 0)
        this.logger.error(
          `Error_getPricesVolume: Aurelius block manager not yet instantiated`,
        );
      this.logger.error(`Error_getPrices:`, e);
      return null;
    }
  }

  async getBuyPricePath(
    amount: bigint,
    params: SmardexPoolOrderedParams[],
  ): Promise<bigint> {
    let price = amount;
    for (const param of params.reverse()) {
      price = await this.getBuyPrice(param, price);
    }
    return price;
  }

  async getSellPricePath(
    amount: bigint,
    params: SmardexPoolOrderedParams[],
  ): Promise<bigint> {
    let price = amount;
    for (const param of params) {
      price = await this.getSellPrice(param, price);
    }
    return price;
  }

  async getBuyPrice(
    priceParams: SmardexPoolOrderedParams,
    destAmount: bigint,
  ): Promise<bigint> {
    const amountIn = computeAmountIn(
      priceParams.token0,
      priceParams.token1,
      priceParams.reserves0,
      priceParams.reserves1,
      priceParams.fictiveReserves0,
      priceParams.fictiveReserves1,
      destAmount,
      priceParams.toToken,
      +priceParams.priceAverageLastTimestamp,
      priceParams.priceAverage0,
      priceParams.priceAverage1,
      priceParams.feesLP,
      priceParams.feesPool,
    ).amount;

    // uncomment to log rates
    // console.log("destAmount.", utils.formatEther(destAmount.toString()))
    // console.log("amountIn", utils.formatEther(amountIn.toString()))

    return BigInt(amountIn.toString());
  }

  async getSellPrice(
    priceParams: SmardexPoolOrderedParams,
    srcAmount: bigint,
  ): Promise<bigint> {
    const amountOut = computeAmountOut(
      priceParams.token0,
      priceParams.token1,
      priceParams.reserves0,
      priceParams.reserves1,
      priceParams.fictiveReserves0,
      priceParams.fictiveReserves1,
      srcAmount,
      priceParams.fromToken,
      +priceParams.priceAverageLastTimestamp,
      priceParams.priceAverage0,
      priceParams.priceAverage1,
      priceParams.feesLP,
      priceParams.feesPool,
    ).amount;

    // uncomment to log rates
    // console.log("srcAmount.", utils.formatEther(srcAmount.toString()))
    // console.log("amountOut", utils.formatEther(amountOut.toString()))
    return BigInt(amountOut.toString());
  }

  // Returns estimated gas cost of calldata for this DEX in multiSwap
  getCalldataGasCost(_poolPrices: PoolPrices<SmardexData>): number | number[] {
    return (
      CALLDATA_GAS_COST.DEX_OVERHEAD +
      CALLDATA_GAS_COST.LENGTH_SMALL +
      // ParentStruct header
      CALLDATA_GAS_COST.OFFSET_SMALL +
      // ParentStruct -> weth
      CALLDATA_GAS_COST.ADDRESS +
      // ParentStruct -> pools[] header
      CALLDATA_GAS_COST.OFFSET_SMALL +
      // ParentStruct -> pools[]
      CALLDATA_GAS_COST.LENGTH_SMALL +
      // ParentStruct -> pools[0]
      CALLDATA_GAS_COST.wordNonZeroBytes(22)
    );
  }

  async findPair(from: Token, to: Token) {
    if (from.address.toLowerCase() === to.address.toLowerCase()) return null;
    const [token0, token1] =
      BigInt(from.address.toLowerCase()) < BigInt(to.address.toLowerCase())
        ? [from, to]
        : [to, from];

    const key = `${token0.address.toLowerCase()}-${token1.address.toLowerCase()}`;
    let pair = this.pairs[key];
    if (pair) return pair;
    const exchange = await this.factory.methods
      .getPair(token0.address, token1.address)
      .call();
    if (exchange === NULL_ADDRESS) {
      pair = { token0, token1 };
    } else {
      pair = { token0, token1, exchange };
    }
    this.pairs[key] = pair;
    return pair;
  }

  async batchCatchUpPairs(pairs: [Token, Token][], blockNumber: number) {
    if (!blockNumber) return;
    const pairsToFetch: SmardexPair[] = [];
    for (const _pair of pairs) {
      const pair = await this.findPair(_pair[0], _pair[1]);
      if (!(pair && pair.exchange)) continue;
      if (!pair.pool) {
        pairsToFetch.push(pair);
      } else if (!pair.pool.getState(blockNumber)) {
        pairsToFetch.push(pair);
      }
    }

    if (!pairsToFetch.length) return;

    const reserves = await this.getManyPoolReserves(pairsToFetch, blockNumber);

    if (reserves.length !== pairsToFetch.length) {
      this.logger.error(
        `Error_getManyPoolReserves didn't get any pool reserves`,
      );
    }

    for (let i = 0; i < pairsToFetch.length; i++) {
      const pairState = reserves[i];
      const pair = pairsToFetch[i];
      if (!pair.pool) {
        await this.addPool(
          pair,
          pairState.reserves0,
          pairState.reserves1,
          pairState.fictiveReserves0,
          pairState.fictiveReserves1,
          pairState.priceAverage0,
          pairState.priceAverage1,
          pairState.feesLP,
          pairState.feesPool,
          blockNumber,
          pairState.priceAverageLastTimestamp,
        );
      } else pair.pool.setState(pairState, blockNumber);
    }
  }

  // On Smardex the fees are upgradable on layer 2.
  public getFeesMultiCallData(pairAddress: string) {
    if (this.isLayer1()) {
      return null;
    }
    const callEntry = {
      target: pairAddress,
      callData: smardexPoolL2.encodeFunctionData('getPairFees'),
    };
    const callDecoder = (values: any[]): SmardexFees => {
      const feesData = smardexPoolL2.decodeFunctionResult(
        'getPairFees',
        values,
      );
      return {
        feesLP: feesData.feesLP_.toBigInt(),
        feesPool: feesData.feesPool_.toBigInt(),
      };
    };
    return {
      callEntry,
      callDecoder,
    };
  }

  protected async addPool(
    pair: SmardexPair,
    reserves0: string,
    reserves1: string,
    fictiveReserves0: string,
    fictiveReserves1: string,
    priceAverage0: string,
    priceAverage1: string,
    feesLp: bigint,
    feesPool: bigint,
    blockNumber: number,
    priceAverageLastTimestamp: number,
  ) {
    const multiCallFeeData = this.getFeesMultiCallData(pair.exchange!);
    pair.pool = new SmardexEventPool(
      this.isLayer1() ? smardexPoolL1 : smardexPoolL2,
      this.dexHelper,
      pair.exchange!,
      pair.token0,
      pair.token1,
      this.logger,
      // For layer 2 we need to fetch the fees
      multiCallFeeData?.callEntry,
      multiCallFeeData?.callDecoder,
      this.isLayer1(),
    );
    pair.pool.addressesSubscribed.push(pair.exchange!);

    await pair.pool.initialize(blockNumber, {
      state: {
        reserves0,
        reserves1,
        fictiveReserves0,
        fictiveReserves1,
        priceAverage0,
        priceAverage1,
        feesLP: feesLp,
        feesPool,
        priceAverageLastTimestamp,
      },
    });
  }

  async getManyPoolReserves(
    pairs: SmardexPair[],
    blockNumber: number,
  ): Promise<SmardexPoolState[]> {
    try {
      const multiCallFeeData = pairs.map(pair =>
        this.getFeesMultiCallData(pair.exchange!),
      );
      const calldata = pairs
        .map((pair, i) => {
          let calldata = [
            {
              target: pair.exchange!,
              callData: smardexPoolL1.encodeFunctionData('getReserves'),
            },
            {
              target: pair.exchange!,
              callData: smardexPoolL1.encodeFunctionData('getFictiveReserves'),
            },
            {
              target: pair.exchange!,
              callData: smardexPoolL1.encodeFunctionData('getPriceAverage'),
            },
          ];
          // Fetch fees only on layer 2
          !this.isLayer1() && calldata.push(multiCallFeeData[i]!.callEntry);
          return calldata;
        })
        .flat();

      const data: { returnData: any[] } =
        await this.dexHelper.multiContract.methods
          .aggregate(calldata)
          .call({}, blockNumber);

      const returnData = _.chunk(data.returnData, 4);
      return pairs.map((_pair: SmardexPair, i) => ({
        reserves0: coder
          .decode(['uint256', 'uint256'], returnData[i][0])[0]
          .toString(),
        reserves1: coder
          .decode(['uint256', 'uint256'], returnData[i][0])[1]
          .toString(),
        fictiveReserves0: coder
          .decode(['uint256', 'uint256'], returnData[i][1])[0]
          .toString(),
        fictiveReserves1: coder
          .decode(['uint256', 'uint256'], returnData[i][1])[1]
          .toString(),
        priceAverage0: coder
          .decode(['uint256', 'uint256', 'uint256'], returnData[i][2])[0]
          .toString(),
        priceAverage1: coder
          .decode(['uint256', 'uint256', 'uint256'], returnData[i][2])[1]
          .toString(),
        priceAverageLastTimestamp: coder
          .decode(['uint256', 'uint256', 'uint256'], returnData[i][2])[2]
          .toString(),
        feesLP: this.isLayer1()
          ? FEES_LAYER_ONE.feesLP
          : multiCallFeeData[i]!.callDecoder(returnData[i][3]).feesLP,
        feesPool: this.isLayer1()
          ? FEES_LAYER_ONE.feesPool
          : multiCallFeeData[i]!.callDecoder(returnData[i][3]).feesPool,
      }));
    } catch (e) {
      this.logger.error(
        `Error_getManyPoolReserves could not get reserves with error:`,
        e,
      );
      return [];
    }
  }

  protected fixPath(path: Address[], srcToken: Address, destToken: Address) {
    return path.map((token: string, i: number) => {
      if (
        (i === 0 && srcToken.toLowerCase() === ETHER_ADDRESS.toLowerCase()) ||
        (i === path.length - 1 &&
          destToken.toLowerCase() === ETHER_ADDRESS.toLowerCase())
      )
        return ETHER_ADDRESS;
      return token;
    });
  }

  // Necessary to get the correct path for the router
  getDirectParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    expectedAmount: NumberAsString,
    _data: SmardexData,
    side: SwapSide,
    permit: string,
    uuid: string,
    feePercent: NumberAsString,
    deadline: NumberAsString,
    partner: string,
    beneficiary: string,
    contractMethod?: string,
  ): TxInfo<SmardexParam> {
    if (!contractMethod) throw new Error(`contractMethod need to be passed`);
    if (permit !== '0x') contractMethod += 'WithPermit';

    const swapParams = ((): SmardexParam => {
      const data = _data as unknown as SmardexData;
      const path = this.fixPath(data.path, srcToken, destToken);

      switch (contractMethod) {
        case SmardexRouterFunctions.sellExactEth:
        case SmardexRouterFunctions.sellExactToken:
        case SmardexRouterFunctions.swapExactIn:
          return [
            srcAmount,
            destAmount,
            data.path,
            data.receiver,
            data.deadline,
          ];

        case SmardexRouterFunctions.buyExactEth:
        case SmardexRouterFunctions.buyExactToken:
        case SmardexRouterFunctions.swapExactOut:
          return [
            destAmount,
            srcAmount,
            data.path,
            data.receiver,
            data.deadline,
          ];

        default:
          throw new Error(`contractMethod=${contractMethod} is not supported`);
      }
    })();

    const encoder = (...params: SmardexParam) =>
      this.routerInterface.encodeFunctionData(contractMethod!, params);
    return {
      params: swapParams,
      encoder,
      networkFee: '0',
    };
  }

  async getPairOrderedParams(
    from: Token,
    to: Token,
    blockNumber: number,
    tokenDexTransferFee: number,
  ): Promise<SmardexPoolOrderedParams | null> {
    const pair = await this.findPair(from, to);
    if (!(pair && pair.pool && pair.exchange)) return null;
    const pairState = pair.pool.getState(blockNumber);
    if (!pairState) {
      this.logger.error(
        `Error_orderPairParams expected reserves, got none (maybe the pool doesn't exist) ${
          from.symbol || from.address
        } ${to.symbol || to.address}`,
      );
      return null;
    }
    // const fee = (pairState.feesPool + tokenDexTransferFee).toString();

    return {
      fromToken: from.address,
      toToken: to.address,
      token0: pair.token0.address,
      token1: pair.token1.address,
      reserves0: BigInt(pairState.reserves0),
      reserves1: BigInt(pairState.reserves1),
      fictiveReserves0: BigInt(pairState.fictiveReserves0),
      fictiveReserves1: BigInt(pairState.fictiveReserves1),
      priceAverage0: BigInt(pairState.priceAverage0),
      priceAverage1: BigInt(pairState.priceAverage1),
      priceAverageLastTimestamp: pairState.priceAverageLastTimestamp,
      exchange: pair.exchange,
      feesLP: BigInt(pairState.feesLP),
      feesPool: BigInt(pairState.feesPool),
    };
  }

  getWETHAddress(srcToken: Address, destToken: Address, weth?: Address) {
    if (!isETHAddress(srcToken) && !isETHAddress(destToken))
      return NULL_ADDRESS;
    return weth || this.dexHelper.config.data.wrappedNativeTokenAddress;
  }

  getAdapterParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    toAmount: NumberAsString,
    data: SmardexData,
    side: SwapSide,
  ): AdapterExchangeParam {
    const payload = this.abiCoder.encodeParameter(
      {
        ParentStruct: {
          path: 'address[]',
          receiver: 'address',
        },
      },
      {
        path: data.path,
        receiver: data.receiver,
      },
    );
    return {
      targetExchange: data.router,
      payload,
      networkFee: '0',
    };
  }

  async getSimpleParam(
    src: Address,
    dest: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    data: SmardexData,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    let routerMethod: any;
    let routerArgs: any;
    if (side === SwapSide.SELL) {
      routerMethod = isETHAddress(src)
        ? SmardexRouterFunctions.sellExactEth
        : SmardexRouterFunctions.swapExactIn;
      routerMethod = isETHAddress(dest)
        ? SmardexRouterFunctions.sellExactToken
        : routerMethod;

      routerArgs = isETHAddress(src)
        ? [destAmount, data.path, data.receiver, data.deadline]
        : [srcAmount, destAmount, data.path, data.receiver, data.deadline];
    } else {
      routerMethod = isETHAddress(src)
        ? SmardexRouterFunctions.buyExactToken
        : SmardexRouterFunctions.swapExactOut;
      routerMethod = isETHAddress(dest)
        ? SmardexRouterFunctions.buyExactEth
        : routerMethod;

      routerArgs = isETHAddress(src)
        ? [destAmount, data.path, data.receiver, data.deadline]
        : [destAmount, srcAmount, data.path, data.receiver, data.deadline];
    }

    const swapData = this.exchangeRouterInterface.encodeFunctionData(
      routerMethod,
      routerArgs,
    );
    return this.buildSimpleParamWithoutWETHConversion(
      src,
      srcAmount,
      dest,
      destAmount,
      swapData,
      data.router,
    );
  }

  isLayer1(): boolean {
    return this.network === Network.MAINNET;
  }

  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    if (!this.subgraphURL) return [];
    const query = `
      query ($token: Bytes!, $limit: Int) {
        pools0: pairs(first: $limit, orderBy: reserveUSD, orderDirection: desc, where: {token0: $token, reserve0_gt: 1, reserve1_gt: 1}) {
        id
        token0 {
          id
          decimals
        }
        token1 {
          id
          decimals
        }
        reserveUSD
      }
      pools1: pairs(first: $limit, orderBy: reserveUSD, orderDirection: desc, where: {token1: $token, reserve0_gt: 1, reserve1_gt: 1}) {
        id
        token0 {
          id
          decimals
        }
        token1 {
          id
          decimals
        }
        reserveUSD
      }
    }`;

    const { data } = await this.dexHelper.httpRequest.post(
      this.subgraphURL,
      {
        query,
        variables: { token: tokenAddress.toLowerCase(), limit },
      },
      SUBGRAPH_TIMEOUT,
      { 'x-api-key': this.dexHelper.config.data.smardexSubgraphAuthToken! },
    );

    if (!(data && data.pools0 && data.pools1))
      throw new Error("Couldn't fetch the pools from the subgraph");
    const pools0 = _.map(data.pools0, pool => ({
      exchange: this.dexKey,
      address: pool.id.toLowerCase(),
      connectorTokens: [
        {
          address: pool.token1.id.toLowerCase(),
          decimals: parseInt(pool.token1.decimals),
        },
      ],
      liquidityUSD: parseFloat(pool.reserveUSD),
    }));

    const pools1 = _.map(data.pools1, pool => ({
      exchange: this.dexKey,
      address: pool.id.toLowerCase(),
      connectorTokens: [
        {
          address: pool.token0.id.toLowerCase(),
          decimals: parseInt(pool.token0.decimals),
        },
      ],
      liquidityUSD: parseFloat(pool.reserveUSD),
    }));

    return _.slice(
      _.sortBy(_.concat(pools0, pools1), [pool => -1 * pool.liquidityUSD]),
      0,
      limit,
    );
  }
}

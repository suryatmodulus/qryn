const streamSelectorOperatorRegistry = require('./registry/stream_selector_operator_registry')
const lineFilterOperatorRegistry = require('./registry/line_filter_operator_registry')
const logRangeAggregationRegistry = require('./registry/log_range_aggregation_registry')
const highLevelAggregationRegistry = require('./registry/high_level_aggregation_registry')
const numberOperatorRegistry = require('./registry/number_operator_registry')
const parameterizedAggregationRegistry = require('./registry/parameterized_aggregation_registry')
const parameterizedUnwrappedRegistry = require('./registry/parameterized_unwrapped_registry')
const complexLabelFilterRegistry = require('./registry/complex_label_filter_expression')
const lineFormat = require('./registry/line_format')
const parserRegistry = require('./registry/parser_registry')
const unwrap = require('./registry/unwrap')
const unwrapRegistry = require('./registry/unwrap_registry')
const { durationToMs, sharedParamNames, getStream } = require('./registry/common')
const compiler = require('./bnf')
const {
  parseMs,
  DATABASE_NAME,
  samplesReadTableName,
  samplesTableName,
  checkVersion,
  parseDurationSecOrDefault
} = require('../lib/utils')
const { getPlg } = require('../plugins/engine')
const Sql = require('@cloki/clickhouse-sql')
const { simpleAnd } = require('./registry/stream_selector_operator_registry/stream_selector_operator_registry')
const logger = require('../lib/logger')
const { QrynBadRequest } = require('../lib/handlers/errors')

/**
 * @param joinLabels {boolean}
 * @returns {Select}
 */
module.exports.initQuery = (joinLabels) => {
  const samplesTable = new Sql.Parameter(sharedParamNames.samplesTable)
  const timeSeriesTable = new Sql.Parameter(sharedParamNames.timeSeriesTable)
  const from = new Sql.Parameter(sharedParamNames.from)
  const to = new Sql.Parameter(sharedParamNames.to)
  const limit = new Sql.Parameter(sharedParamNames.limit)
  const matrix = new Sql.Parameter('isMatrix')
  limit.set(2000)
  const tsClause = new Sql.Raw('')
  tsClause.toString = () => {
    if (to.get()) {
      return Sql.between('samples.timestamp_ns', from, to).toString()
    }
    return Sql.Gt('samples.timestamp_ns', from).toString()
  }
  const tsGetter = new Sql.Raw('')
  tsGetter.toString = () => {
    if (matrix.get()) {
      return 'intDiv(samples.timestamp_ns, 1000000)'
    }
    return 'samples.timestamp_ns'
  }

  const q = (new Sql.Select())
    .select(['samples.string', 'string'],
      ['samples.fingerprint', 'fingerprint'], [tsGetter, 'timestamp_ns'])
    .from([samplesTable, 'samples'])
    .orderBy(['timestamp_ns', 'desc'])
    .where(tsClause)
    .limit(limit)
    .addParam(samplesTable)
    .addParam(timeSeriesTable)
    .addParam(from)
    .addParam(to)
    .addParam(limit)
    .addParam(matrix)
  if (joinLabels) {
    q.join(`${DATABASE_NAME()}.time_series`, 'left any',
      Sql.Eq('samples.fingerprint', new Sql.Raw('time_series.fingerprint')))
    q.select([new Sql.Raw('JSONExtractKeysAndValues(time_series.labels, \'String\')'), 'labels'])
  }
  return q
}

/**
 *
 * @param request {{
 * query: string,
 * limit: number,
 * direction: string,
 * start: string,
 * end: string,
 * step: string,
 * stream?: (function(DataStream): DataStream)[],
 * rawQuery: boolean
 * }}
 * @returns {{query: string, stream: (function (DataStream): DataStream)[], matrix: boolean, duration: number | undefined}}
 */
module.exports.transpile = (request) => {
  const expression = compiler.ParseScript(request.query.trim())
  if (!expression) {
    throw new QrynBadRequest('invalid request')
  }
  const token = expression.rootToken
  if (token.Child('user_macro')) {
    return module.exports.transpile({
      ...request,
      query: module.exports.transpileMacro(token.Child('user_macro'))
    })
  }

  let start = parseMs(request.start, Date.now() - 3600 * 1000)
  let end = parseMs(request.end, Date.now())
  const step = request.step ? Math.floor(parseDurationSecOrDefault(request.step, 5) * 1000) : 0
  /*
  let start = BigInt(request.start || (BigInt(Date.now() - 3600 * 1000) * BigInt(1e6)))
  let end = BigInt(request.end || (BigInt(Date.now()) * BigInt(1e6)))
  const step = BigInt(request.step ? Math.floor(parseFloat(request.step) * 1000) : 0) * BigInt(1e6)
  */
  const joinLabels = ['unwrap_function', 'log_range_aggregation', 'aggregation_operator',
    'agg_statement', 'user_macro', 'parser_expression', 'label_filter_pipeline',
    'line_format_expression', 'labels_format_expression'].some(t => token.Child(t))
  let query = module.exports.initQuery(joinLabels)
  const limit = request.limit ? request.limit : 2000
  const order = request.direction === 'forward' ? 'asc' : 'desc'
  query.orderBy(...query.orderBy().map(o => [o[0], order]))
  const readTable = samplesReadTableName(start)
  query.ctx = {
    step: step,
    legacy: !checkVersion('v3_1', start),
    joinLabels: joinLabels
  }
  let duration = null
  const matrixOp = [
    'aggregation_operator',
    'unwrap_function',
    'log_range_aggregation',
    'parameterized_unwrapped_expression'].find(t => token.Child(t))
  if (matrixOp) {
    duration = durationToMs(token.Child(matrixOp).Child('duration_value').value)
    start = Math.floor(start / duration) * duration
    end = Math.ceil(end / duration) * duration
    query.ctx = {
      ...query.ctx,
      start,
      end
    }
  }
  switch (matrixOp) {
    case 'aggregation_operator':
      query = module.exports.transpileAggregationOperator(token, query)
      break
    case 'unwrap_function':
      query = module.exports.transpileUnwrapFunction(token, query)
      break
    case 'log_range_aggregation':
      query = module.exports.transpileLogRangeAggregation(token, query)
      break
    case 'parameterized_unwrapped_expression':
      query = module.exports.transpileParameterizedUnwrappedExpression(token, query)
      break
    default:
      // eslint-disable-next-line no-case-declarations
      const _query = module.exports.transpileLogStreamSelector(token, query)
      // eslint-disable-next-line no-case-declarations
      const wth = new Sql.With('sel_a', _query)
      query = (new Sql.Select())
        .with(wth)
        .from(new Sql.WithReference(wth))
        .orderBy(['labels', order], ['timestamp_ns', order])
      setQueryParam(query, sharedParamNames.limit, limit)
      if (!joinLabels) {
        query.join(`${DATABASE_NAME()}.time_series`, 'left any',
          Sql.Eq('sel_a.fingerprint', new Sql.Raw('time_series.fingerprint')))
        query.select([new Sql.Raw('JSONExtractKeysAndValues(time_series.labels, \'String\')'), 'labels'],
          new Sql.Raw('sel_a.*'))
      }
  }
  if (token.Child('agg_statement') && token.Child('compared_agg_statement_cmp')) {
    const op = token.Child('compared_agg_statement_cmp').Child('number_operator').value
    query = numberOperatorRegistry[op](token.Child('agg_statement'), query)
  }
  if (token.Child('parameterized_expression')) {
    const op = token.Child('parameterized_expression_fn').value
    query = parameterizedAggregationRegistry[op](token.Child('parameterized_expression'), query)
  }
  setQueryParam(query, sharedParamNames.timeSeriesTable, `${DATABASE_NAME()}.time_series`)
  setQueryParam(query, sharedParamNames.samplesTable, `${DATABASE_NAME()}.${readTable}`)
  setQueryParam(query, sharedParamNames.from, start + '000000')
  setQueryParam(query, sharedParamNames.to, end + '000000')
  setQueryParam(query, 'isMatrix', query.ctx.matrix)
  logger.debug(query.toString())
  return {
    query: request.rawQuery ? query : query.toString(),
    matrix: !!query.ctx.matrix,
    duration: query.ctx && query.ctx.duration ? query.ctx.duration : 1000,
    stream: getStream(query)
  }
}

/**
 *
 * @param query {Select}
 * @param name {string}
 * @param val {any}
 */
const setQueryParam = (query, name, val) => {
  if (query.getParam(name)) {
    query.getParam(name).set(val)
  }
}

/**
 *
 * @param token {Token}
 * @param query {Select}
 * @returns {Select}
 */
module.exports.transpileParameterizedUnwrappedExpression = (token, query) => {
  query = module.exports.transpileLogStreamSelector(token, query)
  if (token.Child('unwrap_value_statement')) {
    if (token.Child('log_pipeline')) {
      throw new Error('log pipeline not supported')
    }
    query = transpileUnwrapMetrics(token, query)
  } else {
    query = module.exports.transpileUnwrapExpression(token.Child('unwrap_expression'), query)
  }
  return parameterizedUnwrappedRegistry[token.Child('parameterized_unwrapped_expression_fn').value](
    token, query)
}

/**
 *
 * @param request {{
 *  query: string,
 *  suppressTime?: boolean,
 *  stream?: (function(DataStream): DataStream)[],
 *  samplesTable?: string,
 *  rawRequest: boolean}}
 * @returns {{query: string  | registry_types.Request,
 * stream: (function(DataStream): DataStream)[]}}
 */
module.exports.transpileTail = (request) => {
  const expression = compiler.ParseScript(request.query.trim())
  const denied = ['user_macro', 'aggregation_operator', 'unwrap_function', 'log_range_aggregation']
  for (const d of denied) {
    if (expression.rootToken.Child(d)) {
      throw new Error(`${d} is not supported. Only raw logs are supported`)
    }
  }

  let query = module.exports.initQuery(true)
  query.ctx = {
    ...(query.ctx || {}),
    legacy: true
  }
  query = module.exports.transpileLogStreamSelector(expression.rootToken, query)
  setQueryParam(query, sharedParamNames.timeSeriesTable, `${DATABASE_NAME()}.time_series`)
  setQueryParam(query, sharedParamNames.samplesTable, `${DATABASE_NAME()}.${samplesTableName}`)
  setQueryParam(query, sharedParamNames.from, new Sql.Raw('(toUnixTimestamp(now()) - 5) * 1000000000'))
  query.order_expressions = []
  query.orderBy(['timestamp_ns', 'asc'])
  query.limit(undefined, undefined)
  // logger.debug(query.toString())
  return {
    query: request.rawRequest ? query : query.toString(),
    stream: getStream(query)
  }
}

/**
 *
 * @param request {string[]} ['{ts1="a1"}', '{ts2="a2"}', ...]
 * @returns {string} clickhouse query
 */
module.exports.transpileSeries = (request) => {
  if (request.length === 0) {
    return ''
  }
  /**
   *
   * @param req {string}
   * @returns {Select}
   */
  const getQuery = (req) => {
    const expression = compiler.ParseScript(req.trim())
    let query = module.exports.transpileLogStreamSelector(expression.rootToken, module.exports.initQuery())
    query = simpleAnd(query, new Sql.Raw('1 == 1'))
    const _query = query.withs.str_sel.query
    if (query.with() && query.with().idx_sel) {
      _query.with(query.withs.idx_sel)
    }
    _query.params = query.params
    _query.columns = []
    return _query.select('labels')
  }
  class UnionAll extends Sql.Raw {
    constructor (sqls) {
      super()
      this.sqls = [sqls]
    }

    toString () {
      return this.sqls.map(sql => `(${sql})`).join(' UNION ALL ')
    }
  }
  const query = getQuery(request[0])
  query.withs.idx_sel.query = new UnionAll(query.withs.idx_sel.query)
  for (const req of request.slice(1)) {
    const _query = getQuery(req)
    query.withs.idx_sel.query.sqls.push(_query.withs.idx_sel.query)
  }
  setQueryParam(query, sharedParamNames.timeSeriesTable, `${DATABASE_NAME()}.time_series`)
  setQueryParam(query, sharedParamNames.samplesTable, `${DATABASE_NAME()}.${samplesReadTableName()}`)
  // logger.debug(query.toString())
  return query.toString()
}

/**
 *
 * @param token {Token}
 * @returns {string}
 */
module.exports.transpileMacro = (token) => {
  const plg = Object.values(getPlg({ type: 'macros' })).find(m => token.Child(m._main_rule_name))
  return plg.stringify(token)
}

/**
 *
 * @param token {Token}
 * @param query {Select}
 * @returns {Select}
 */
module.exports.transpileAggregationOperator = (token, query) => {
  const agg = token.Child('aggregation_operator')
  if (token.Child('log_range_aggregation')) {
    query = module.exports.transpileLogRangeAggregation(agg, query)
  } else if (token.Child('unwrap_function')) {
    query = module.exports.transpileUnwrapFunction(agg, query)
  }
  return highLevelAggregationRegistry[agg.Child('aggregation_operator_fn').value](token, query)
}

/**
 *
 * @param token {Token}
 * @param query {Select}
 * @returns {Select}
 */
module.exports.transpileLogRangeAggregation = (token, query) => {
  const agg = token.Child('log_range_aggregation')
  query = module.exports.transpileLogStreamSelector(agg, query)
  return logRangeAggregationRegistry[agg.Child('log_range_aggregation_fn').value](token, query)
}

/**
 *
 * @param token {Token}
 * @param query {Sql.Select}
 * @returns {Sql.Select}
 */
module.exports.transpileLogStreamSelector = (token, query) => {
  const rules = token.Children('log_stream_selector_rule')
  for (const rule of rules) {
    const op = rule.Child('operator').value
    query = streamSelectorOperatorRegistry[op](rule, query)
  }
  for (const pipeline of token.Children('log_pipeline')) {
    if (pipeline.Child('line_filter_expression')) {
      const op = pipeline.Child('line_filter_operator').value
      query = lineFilterOperatorRegistry[op](pipeline, query)
      continue
    }
    if (pipeline.Child('parser_expression')) {
      const op = pipeline.Child('parser_fn_name').value
      query = parserRegistry[op](pipeline, query)
      continue
    }
    if (pipeline.Child('label_filter_pipeline')) {
      query = module.exports.transpileLabelFilterPipeline(pipeline.Child('label_filter_pipeline'), query)
      continue
    }
    if (pipeline.Child('line_format_expression')) {
      query = lineFormat(pipeline, query)
      continue
    }
  }
  for (const c of ['labels_format_expression']) {
    if (token.Children(c).length > 0) {
      throw new Error(`${c} not supported`)
    }
  }
  return query
}

/**
 *
 * @param pipeline {Token}
 * @param query {Select}
 * @returns {Select}
 */
module.exports.transpileLabelFilterPipeline = (pipeline, query) => {
  return complexLabelFilterRegistry(pipeline.Child('complex_label_filter_expression'), query)
}

/**
 *
 * @param token {Token}
 * @param query {Select}
 * @returns {Select}
 */
module.exports.transpileUnwrapFunction = (token, query) => {
  query = module.exports.transpileLogStreamSelector(token, query)
  if (token.Child('unwrap_value_statement')) {
    if (token.Child('log_pipeline')) {
      throw new Error('log pipeline not supported')
    }
    query = transpileUnwrapMetrics(token, query)
  } else {
    query = module.exports.transpileUnwrapExpression(token.Child('unwrap_expression'), query)
  }
  return unwrapRegistry[token.Child('unwrap_fn').value](token, query)
}

/**
 * @param token {Token}
 * @param query {Select}
 * @returns {Select}
 */
const transpileUnwrapMetrics = (token, query) => {
  query.select_list = query.select_list.filter(f => f[1] !== 'string')
  query.select(['value', 'unwrapped'])
  return query
}

/**
 *
 * @param token {Token}
 * @param query {Select}
 * @returns {Select}
 */
module.exports.transpileUnwrapExpression = (token, query) => {
  return unwrap(token.Child('unwrap_statement'), query)
}

/**
 *
 * @param query {Select | registry_types.UnionRequest}
 * @returns {string}
 */
module.exports.requestToStr = (query) => {
  if (query.requests) {
    return query.requests.map(r => `(${module.exports.requestToStr(r)})`).join(' UNION ALL ')
  }
  let req = query.with
    ? 'WITH ' + Object.entries(query.with).filter(e => e[1])
        .map(e => `${e[0]} as (${module.exports.requestToStr(e[1])})`).join(', ')
    : ''
  req += ` SELECT ${query.distinct ? 'DISTINCT' : ''} ${query.select.join(', ')} FROM ${query.from} `
  for (const clause of query.left_join || []) {
    req += ` LEFT JOIN ${clause.name} ON ${whereBuilder(clause.on)}`
  }
  req += query.where && query.where.length ? ` WHERE ${whereBuilder(query.where)} ` : ''
  req += query.group_by ? ` GROUP BY ${query.group_by.join(', ')}` : ''
  req += query.having && query.having.length ? ` HAVING ${whereBuilder(query.having)}` : ''
  req += query.order_by ? ` ORDER BY ${query.order_by.name.map(n => n + ' ' + query.order_by.order).join(', ')} ` : ''
  req += typeof (query.limit) !== 'undefined' ? ` LIMIT ${query.limit}` : ''
  req += typeof (query.offset) !== 'undefined' ? ` OFFSET ${query.offset}` : ''
  req += query.final ? ' FINAL' : ''
  return req
}

module.exports.stop = () => {
  require('./registry/line_format/go_native_fmt').stop()
}

/**
 *
 * @param clause {(string | string[])[]}
 */
const whereBuilder = (clause) => {
  const op = clause[0]
  const _clause = clause.slice(1).map(c => Array.isArray(c) ? `(${whereBuilder(c)})` : c)
  return _clause.join(` ${op} `)
}

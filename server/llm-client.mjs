const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT'
]);

function normalizeBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('LLM 节点必须使用 HTTP 或 HTTPS');
  return url.toString().replace(/\/$/, '');
}

function redact(value, secrets) {
  let text = String(value || '');
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .slice(0, 500);
}

function providerErrorDetails(body, secrets) {
  const source = body?.error && typeof body.error === 'object' ? body.error : body;
  const details = {};
  if (source?.code != null) details.providerCode = redact(source.code, secrets);
  if (source?.type != null) details.providerType = redact(source.type, secrets);
  if (source?.message != null) details.providerMessage = redact(source.message, secrets);
  return details;
}

function isNetworkFailure(error) {
  const code = error?.code || error?.cause?.code;
  return error?.name === 'AbortError'
    || error?.name === 'TimeoutError'
    || NETWORK_ERROR_CODES.has(code)
    || error instanceof TypeError;
}

function networkFailureReason(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 23) return 'timeout';
  return error?.cause?.code || error?.code || error?.name || 'network_error';
}

function gatewayError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.details = details;
  return error;
}

function parseBody(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 500) }; }
}

export function extractTokenUsage(body) {
  const usage = body?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens);
  const totalTokens = Number(usage.total_tokens);
  const result = {};
  if (Number.isFinite(inputTokens)) result.inputTokens = inputTokens;
  if (Number.isFinite(outputTokens)) result.outputTokens = outputTokens;
  if (Number.isFinite(totalTokens)) result.totalTokens = totalTokens;
  return Object.keys(result).length ? result : null;
}

export function createLlmClient({ primaryBaseUrl, directBaseUrl, model, apiKey, fetchImpl = fetch, timeoutMs = 45_000 }) {
  const primary = normalizeBaseUrl(primaryBaseUrl);
  const direct = normalizeBaseUrl(directBaseUrl);
  const nodes = [
    { name: 'primary', baseUrl: primary },
    ...(direct === primary ? [] : [{ name: 'direct', baseUrl: direct }])
  ];
  const secret = String(apiKey || '').trim();
  const modelId = String(model || '').trim();

  async function request(endpoint, { method = 'POST', payload, timeout = timeoutMs } = {}) {
    if (!secret) {
      const error = new Error('服务端未配置 LLM_API_KEY');
      error.code = 'LLM_KEY_MISSING';
      error.status = 503;
      throw error;
    }

    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const startedAt = Date.now();
      let response;
      try {
        response = await fetchImpl(`${node.baseUrl}${endpoint}`, {
          method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${secret}`,
            ...(payload === undefined ? {} : { 'content-type': 'application/json' })
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          signal: AbortSignal.timeout(timeout)
        });
      } catch (error) {
        const canFallback = index + 1 < nodes.length && isNetworkFailure(error);
        if (canFallback) continue;
        throw gatewayError('LLM 节点网络连接失败', 'LLM_NETWORK_ERROR', {
          activeBaseUrl: node.baseUrl,
          node: node.name,
          reason: redact(networkFailureReason(error), [secret])
        });
      }

      const body = parseBody(await response.text());
      const meta = {
        activeBaseUrl: node.baseUrl,
        node: node.name,
        fallbackUsed: index > 0,
        endpoint,
        httpStatus: response.status,
        durationMs: Date.now() - startedAt
      };
      if (!response.ok) {
        throw gatewayError(`LLM 网关返回 HTTP ${response.status}`, 'LLM_GATEWAY_ERROR', {
          ...meta,
          providerStatus: response.status,
          ...providerErrorDetails(body, [secret])
        });
      }
      return { body, meta: { ...meta, usage: extractTokenUsage(body) } };
    }

    throw gatewayError('LLM 节点网络连接失败', 'LLM_NETWORK_ERROR');
  }

  async function validateModel() {
    const result = await request('/models', { method: 'GET', timeout: 20_000 });
    const models = Array.isArray(result.body?.data) ? result.body.data.map((item) => item?.id).filter(Boolean) : [];
    return {
      ...result,
      models,
      exactModelFound: models.includes(modelId)
    };
  }

  return {
    configured: Boolean(secret),
    model: modelId,
    primaryBaseUrl: primary,
    directBaseUrl: direct,
    request,
    validateModel
  };
}


'use strict';
/* B7: name-based hints for the "add models" wizard. Pure and offline: no network, no storage.
 * Everything here is a SUGGESTION from the model's name; the UI must label it "建议，未经验证",
 * the user can change it, and nothing here is treated as a verified capability.
 * Capability keys match catalog/providers.v1.json "capabilities". */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModelHints = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Non-chat models cannot fill a chat role: default unchecked, with a reason shown to the user.
  const NON_CHAT = [
    [/embed|text-embedding|bge-|\bm3e\b/i, '向量嵌入模型（用于检索，不能对话）'],
    [/rerank/i, '重排序模型（用于检索排序，不能对话）'],
    [/realtime|s2s|livetranslate/i, '实时语音/同传模型（需要实时音频接口）'],
    [/(^|[-_/])(asr|tts|stt)([-_.]|$)|whisper|speech|paraformer|sensevoice|cosyvoice|sambert|(^|[-_/])audio[-_]|fun-asr/i, '语音识别/合成模型（不是文字对话接口）'],
    [/z-image|wanx|wan\d|flux|sdxl|stable-diffusion|dall-e|gpt-image|(^|[-_/])image[-_]|imagen|seedream|(^|[-_/])t2i|(^|[-_/])i2v|(^|[-_/])t2v|video/i, '图像/视频生成模型（不是文字对话接口）'],
    [/moderation|guard/i, '内容审核模型（不能完成岗位任务）'],
    [/(^|[-_.])ocr([-_.]|$)/i, '文字识别模型（只做图片识字）'],
    [/(^|[-_/])mt[-_]|(^|[-_/])mt$|translation/i, '专用翻译模型（只做翻译，不适合一般岗位）'],
  ];
  // Name-pattern rules (B7 acceptance): tier/kind words in the model name.
  const RULES = [
    [/flash|turbo|lite|mini|nano|air|haiku|small|speed|instant/i, ['writing', 'fast', 'low_cost']],
    [/(^|[-_.])(pro|max|plus|ultra|opus|large)([-_.\d]|$)/i, ['reasoning', 'long_context', 'research']],
    [/coder|codex|code|devstral|starcoder/i, ['coding']],
    [/(^|[-_.])(vl|omni|vision)([-_.\d]|$)|-v$|4v|visual/i, ['vision']],
    [/reason|think|(^|[-_])r1([-_]|$)|qwq|o1|o3|o4/i, ['reasoning']],
  ];
  // Built-in family table: families whose vendors publish Chinese as a primary language.
  const FAMILIES = [
    [/deepseek|qwen|qwq|tongyi|glm|chatglm|zhipu|moonshot|kimi|doubao|ernie|hunyuan|baichuan|minimax|abab|(^|[-_/])yi[-_]|spark|step-|internlm|ling-|vanchin|antdigital/i, ['chinese']],
    [/moonshot|kimi|long/i, ['long_context']],
  ];
  function nonChatReason(modelId) {
    const id = String(modelId || '');
    for (const [re, why] of NON_CHAT) if (re.test(id)) return why;
    return null;
  }
  // #10 v2.2 (owner): general chat models are assumed to cover these common abilities by default,
  // so simple mode never stalls on "capability not declared". Still a suggestion, never verified.
  const GENERAL = ['reasoning', 'writing', 'chinese', 'data_analysis'];
  function suggestCapabilities(modelId, known) {
    const id = String(modelId || ''), out = new Set();
    if (!id || nonChatReason(id)) return [];
    GENERAL.forEach(c => out.add(c));
    for (const [re, caps] of RULES) if (re.test(id)) caps.forEach(c => out.add(c));
    for (const [re, caps] of FAMILIES) if (re.test(id)) caps.forEach(c => out.add(c));
    const list = [...out];
    return Array.isArray(known) ? list.filter(c => known.includes(c)) : list;
  }
  // "平台 · 模型名" for every model picker; falls back safely when fields are missing.
  function platformLabel(m) {
    if (!m) return '';
    if (m.platformLabel) return String(m.platformLabel);
    const platform = m.providerName || m.providerId || '', model = m.modelId || m.displayName || m.connectionId || '';
    return platform ? platform + ' · ' + model : String(model);
  }
  // Dated snapshot (e.g. -2026-07-15, -20260715, -0731): keep only each model's latest alias.
  const DATED = /[-_](20\d{2}-\d{2}-\d{2}|20\d{6}|\d{4})$/;
  function baseName(id) { return String(id).replace(DATED, ''); }
  function isSnapshot(id) { return DATED.test(String(id)); }
  // From a provider's model list: chat models to add, and skipped ones with reasons.
  function selectForAutoAdd(ids) {
    const all = [...new Set((ids || []).map(String).filter(Boolean))], keep = [], skipped = [];
    const aliases = new Set(all.filter(id => !isSnapshot(id)));
    const newestSnapshot = new Map();
    for (const id of all) if (isSnapshot(id)) { const b = baseName(id); if (!aliases.has(b) && (!newestSnapshot.has(b) || id > newestSnapshot.get(b))) newestSnapshot.set(b, id); }
    for (const id of all) {
      const why = nonChatReason(id);
      if (why) { skipped.push({ modelId: id, reason: why }); continue; }
      if (id.includes('/')) { skipped.push({ modelId: id, reason: '平台代售的第三方模型（需要时可在下方手动添加）' }); continue; }
      if (/(^|[-_.])\d+(\.\d+)?b([-_.]|$)/i.test(id)) { skipped.push({ modelId: id, reason: '开源尺寸版本（需要时可在下方手动添加）' }); continue; }
      if (isSnapshot(id) && newestSnapshot.get(baseName(id)) !== id) { skipped.push({ modelId: id, reason: '带日期的旧快照版本（已保留最新别名 ' + (aliases.has(baseName(id)) ? baseName(id) : newestSnapshot.get(baseName(id))) + '）' }); continue; }
      keep.push(id);
    }
    return { keep, skipped };
  }
  // Price tier from the name: low (flash/turbo...), high (pro/max...), otherwise mid. A guess, not a price.
  function tierOf(modelId) {
    const id = String(modelId || '');
    if (/flash|turbo|lite|mini|nano|air|haiku|small|speed|instant/i.test(id)) return 'low';
    if (/(^|[-_.])(pro|max|plus|ultra|opus|large)([-_.\d]|$)/i.test(id)) return 'high';
    return 'mid';
  }
  return { nonChatReason, suggestCapabilities, platformLabel, selectForAutoAdd, isSnapshot, tierOf, GENERAL, NON_CHAT, RULES, FAMILIES };
});

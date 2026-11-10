'use strict';
/*
 * Capability Matcher：按岗位需要的能力推荐模型连接，并说明理由、适合岗位、不足、搭配建议与是否付费。
 * 只依据平台掌握的事实：用户声明的能力标签、连接测试结果、连接状态、计费方式、服务商。
 * 不根据品牌名下结论；没有可靠依据的信息（上下文长度、价格、免费额度、工具支持等）一律标“未知 / 待验证”。
 */
const FREE = new Set(['local', 'free_tier']);
const PRICING_TEXT = { paid_api: '需要付费（按量计费 API）', free_tier: '用户已标记为免费额度（额度上限请以服务商为准）', local: '本地运行，不产生 API 费用', unknown: '费用未知（待验证），按可能付费处理' };

function scoreOne(c, required, budget, capNames) {
  const declared = new Set(c.capabilities || []);
  const hit = required.filter(t => declared.has(t)), miss = required.filter(t => !declared.has(t));
  let score = required.length ? (hit.length / required.length) * 60 : 30;
  const reasons = [], gaps = [];
  if (hit.length) reasons.push('已声明具备：' + hit.map(t => capNames[t] || t).join('、') + '（用户声明，未经平台验证）');
  if (miss.length) gaps.push('未声明：' + miss.map(t => capNames[t] || t).join('、'));
  if (c.status === 'available') { score += 25; reasons.push('最近一次连接测试成功'); }
  else if (c.status === 'untested') { score += 5; gaps.push('尚未做连接测试'); }
  else if (c.status === 'error') { score -= 20; gaps.push('最近一次连接测试失败' + (c.lastTest && c.lastTest.hint ? '：' + c.lastTest.hint : '')); }
  if (FREE.has(c.pricingMode)) { score += budget && budget.mode === 'free_first' ? 15 : 5; reasons.push(PRICING_TEXT[c.pricingMode]); }
  else gaps.push(PRICING_TEXT[c.pricingMode] || PRICING_TEXT.unknown);
  gaps.push('上下文长度、工具支持等未登记（未知）');
  return { score: Math.round(score), hit, miss, reasons, gaps };
}

/*
 * recommend({ requiredCapabilities, connections, budget, capNames, roles, excludeIds })
 *   connections：ModelRegistry.list() 的公开视图；roles：可选，用于判断“适合承担什么岗位”（[{roleId,name,requiredCapabilities}]）
 * 返回按得分排序的建议；停用 / 未就绪的连接不推荐。
 */
function recommend({ requiredCapabilities = [], connections = [], budget = null, capNames = {}, roles = [], excludeIds = [] } = {}) {
  const pool = connections.filter(c => c.enabled && c.ready && !excludeIds.includes(c.connectionId));
  const scored = pool.map(c => ({ c, ...scoreOne(c, requiredCapabilities, budget, capNames) })).sort((a, b) => b.score - a.score);
  return scored.map(({ c, score, hit, miss, reasons, gaps }) => {
    const suitedRoles = roles.filter(r => (r.requiredCapabilities || []).every(t => (c.capabilities || []).includes(t))).map(r => r.name);
    /* 搭配建议：优先能补上缺失能力、且来自不同服务商（便于交叉审核）的连接 */
    const partner = pool.filter(o => o.connectionId !== c.connectionId)
      .map(o => ({ o, cover: miss.filter(t => (o.capabilities || []).includes(t)).length, diff: o.providerId !== c.providerId ? 1 : 0 }))
      .sort((a, b) => b.cover - a.cover || b.diff - a.diff)[0];
    return {
      connectionId: c.connectionId, displayName: c.displayName, platformLabel: c.platformLabel, providerId: c.providerId, score,
      why: reasons.length ? reasons : ['没有可依据的优势信息'],
      suitedRoles: suitedRoles.length ? suitedRoles : ['（按已声明能力，暂无完全匹配的岗位）'],
      shortcomings: gaps,
      pairWith: partner ? { connectionId: partner.o.connectionId, displayName: partner.o.displayName, reason: partner.cover ? '可补上缺失的能力' : partner.diff ? '来自不同服务商，适合交叉审核' : '可作为备用' } : null,
      payment: FREE.has(c.pricingMode) ? 'no' : c.pricingMode === 'paid_api' ? 'yes' : 'unknown',
      paymentText: PRICING_TEXT[c.pricingMode] || PRICING_TEXT.unknown,
      verified: c.status === 'available' ? ['连接可用'] : [],
      unverified: ['能力标签为用户声明', '价格与免费额度'],
    };
  });
}

module.exports = { recommend, PRICING_TEXT };

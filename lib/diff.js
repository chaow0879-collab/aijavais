'use strict';
/*
 * 行级差异（Myers O(ND) 算法），输出统一 diff 格式与统计。用于文件版本比较、审核与修订对照。
 */
function myers(a, b) {
  const n = a.length, m = b.length, max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return [];
}
function backtrack(trace, a, b, dEnd) {
  const ops = [];
  let x = a.length, y = b.length;
  for (let d = dEnd; d >= 0; d--) {
    const v = trace[d], k = x - y;
    const prevK = (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) ? k + 1 : k - 1;
    const prevX = v.get(prevK) ?? 0, prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ t: ' ', s: a[x - 1] }); x--; y--; }
    if (d > 0) { if (x === prevX) ops.push({ t: '+', s: b[y - 1] }); else ops.push({ t: '-', s: a[x - 1] }); }
    x = prevX; y = prevY;
  }
  return ops.reverse();
}

/* 返回 { added, removed, unchanged, unified, truncated } */
function diffText(oldText, newText, { context = 3, maxLines = 20000 } = {}) {
  const a = String(oldText || '').split('\n'), b = String(newText || '').split('\n');
  if (a.length > maxLines || b.length > maxLines) return { added: null, removed: null, unchanged: null, unified: '', truncated: true, note: '文件过大，未逐行比较' };
  const ops = myers(a, b);
  let added = 0, removed = 0, unchanged = 0;
  for (const o of ops) { if (o.t === '+') added++; else if (o.t === '-') removed++; else unchanged++; }
  /* 统一格式：只保留改动附近 context 行 */
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.t !== ' ') for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true; });
  const out = []; let gap = false;
  ops.forEach((o, i) => { if (keep[i]) { out.push(o.t + ' ' + o.s); gap = false; } else if (!gap) { out.push('@@ …'); gap = true; } });
  return { added, removed, unchanged, unified: out.join('\n'), truncated: false };
}

module.exports = { diffText };

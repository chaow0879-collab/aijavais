#!/usr/bin/env node
/*
 * 本地密码恢复：在运行 AIJAVAIS 的服务器本机执行。
 *   node tools/reset-password.js            （数据目录默认 ./data，或用环境变量 AIJ_DATA_DIR 指定）
 * 作用：清除管理员密码，撤销所有登录会话和大屏观看会话，生成新的一次性设置码。
 * 运行中的服务会自动发现变化（不必重启）；之后打开网页，用新设置码重新设置密码。
 * 只有能登录这台服务器、能读写 data 目录的人才能执行，这就是“本地安全恢复”的前提。
 */
'use strict';
const path = require('path');
const { AuthStore } = require('../lib/auth');

const dir = process.env.AIJ_DATA_DIR ? path.resolve(process.env.AIJ_DATA_DIR) : path.join(__dirname, '..', 'data');
if (!process.argv.includes('--yes')) {
  console.log('将清除 AIJAVAIS 管理员密码并撤销所有登录会话（数据目录：' + dir + '）。');
  console.log('确认请加参数 --yes：node tools/reset-password.js --yes');
  process.exit(1);
}
const store = new AuthStore({ dir });
const code = store.resetLocal();
console.log('已重置。新的一次性设置码：' + code);
console.log('（同时写入 ' + path.join(dir, 'setup-code.txt') + '）打开网页，用它重新设置密码。');

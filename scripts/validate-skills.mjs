#!/usr/bin/env node
// 校验 skills/*/SKILL.md 的 YAML frontmatter，在发布前拦住会让 loader 跳过 skill 的两类错误：
//   1. frontmatter YAML 解析失败 —— 最常见的是 "..." 包裹的 description 里又写了未转义的
//      ASCII 双引号（中文写作里极易踩），YAML 在第一个内层引号就提前闭合 → 整段 frontmatter 报错。
//   2. description 超过 Agent Skills 规范的 1024 字符上限 —— Claude Code 运行时宽松不报，
//      但发布校验器 / `skills` CLI / Codex 等严格 loader 会直接拒绝加载。
// 任一 skill 出错即非零退出，可直接挂到 CI / pre-commit 作为门禁。
//
// 零依赖：Node 无内置 YAML 解析，这里手写一个只覆盖 frontmatter 顶层标量的聚焦 linter，
// 精确复刻引号标量的闭合规则（这正是上面第 1 类错误的根因）。判定结果与 pyyaml 对齐。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, 'skills');
const DESC_LIMIT = 1024; // Agent Skills 规范：description 上限
const NAME_LIMIT = 64; // Agent Skills 规范：name 上限

// 读一个引号标量（可跨行）。返回 { value, nextLine } 或 { error, errLine, col, nextLine }。
function readQuoted(lines, startLine, openCol, q) {
  let li = startLine;
  let ci = openCol + 1; // 跳过开引号
  let value = '';
  while (li < lines.length) {
    const s = lines[li];
    while (ci < s.length) {
      const ch = s[ci];
      if (q === '"' && ch === '\\') {
        value += s[ci + 1] ?? '';
        ci += 2;
        continue;
      }
      if (ch === q) {
        // 单引号里 '' 表示一个字面量单引号
        if (q === "'" && s[ci + 1] === "'") {
          value += "'";
          ci += 2;
          continue;
        }
        const after = s.slice(ci + 1).trim();
        if (after !== '' && !after.startsWith('#')) {
          // 闭引号之后还有内容 —— 几乎一定是值里有个未转义的 q，把字符串提前截断了
          const kind = q === '"' ? 'double' : 'single';
          return {
            error: `value 里有未转义的 ${q}，${kind}-quoted 标量被提前闭合（其后还有内容）`,
            errLine: li + 1,
            col: ci + 2,
            nextLine: li + 1,
          };
        }
        return { value, nextLine: li + 1 };
      }
      value += ch;
      ci++;
    }
    value += ' '; // 跨行折叠成空格
    li++;
    ci = 0;
  }
  const kind = q === '"' ? 'double' : 'single';
  return { error: `${kind}-quoted 标量未闭合`, errLine: startLine + 1, col: openCol + 1, nextLine: lines.length };
}

// 读一个 flow 集合 {…} / […]（metadata 用），做括号匹配（跳过引号内部）。
function readFlow(lines, startLine, openCol) {
  let depth = 0;
  let li = startLine;
  let ci = openCol;
  let value = '';
  let inStr = null;
  while (li < lines.length) {
    const s = lines[li];
    while (ci < s.length) {
      const ch = s[ci];
      value += ch;
      if (inStr) {
        if (ch === '\\' && inStr === '"') {
          value += s[ci + 1] ?? '';
          ci += 2;
          continue;
        }
        if (ch === inStr) inStr = null;
        ci++;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return { value, nextLine: li + 1 };
      }
      ci++;
    }
    value += '\n';
    li++;
    ci = 0;
  }
  return { error: 'flow 集合未闭合', value, nextLine: lines.length };
}

// 读块标量（> 折叠 / | 字面），收集后续缩进行。
function readBlockScalar(lines, startLine, indicator) {
  const block = [];
  let j = startLine + 1;
  while (j < lines.length && (lines[j].trim() === '' || /^\s/.test(lines[j]))) {
    block.push(lines[j].replace(/^\s+/, ''));
    j++;
  }
  const joined = indicator.startsWith('>') ? block.join(' ') : block.join('\n');
  return { value: joined.trim(), nextLine: j };
}

// 解析 frontmatter 的顶层 key: value，返回 { values, errors }。
function lintFrontmatter(fm) {
  const lines = fm.split('\n');
  const errors = [];
  const values = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!m) {
      i++; // 上一条 key 的延续行已被各自的 reader 消费；这里出现说明是缩进续行，跳过
      continue;
    }
    const key = m[1];
    const rest = m[2];
    const trimmedLeft = rest.replace(/^\s+/, '');
    const valCol = line.length - trimmedLeft.length;

    if (trimmedLeft === '' || trimmedLeft.startsWith('#')) {
      // 空值：把后续更深缩进行整体当作该 key 的嵌套块（不深入校验）
      const block = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || /^\s/.test(lines[j]))) {
        block.push(lines[j]);
        j++;
      }
      values[key] = block.join('\n');
      i = j;
      continue;
    }

    const c = trimmedLeft[0];
    if (c === '"' || c === "'") {
      const res = readQuoted(lines, i, valCol, c);
      if (res.error) errors.push({ key, line: res.errLine, col: res.col, msg: res.error });
      else values[key] = res.value;
      i = res.nextLine;
      continue;
    }
    if (c === '{' || c === '[') {
      const res = readFlow(lines, i, valCol);
      if (res.error) errors.push({ key, line: i + 1, msg: res.error });
      values[key] = res.value ?? '';
      i = res.nextLine;
      continue;
    }
    if (c === '>' || c === '|') {
      const res = readBlockScalar(lines, i, trimmedLeft);
      values[key] = res.value;
      i = res.nextLine;
      continue;
    }
    // plain 标量（本仓库均为单行，如 name: aicoin-xxx）
    values[key] = trimmedLeft.replace(/\s+$/, '');
    i++;
  }
  return { values, errors };
}

function check(dir) {
  const file = join(SKILLS_DIR, dir, 'SKILL.md');
  const txt = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const problems = [];

  if (!txt.startsWith('---')) {
    problems.push('缺少 YAML frontmatter（文件未以 --- 开头）');
    return { dir, problems, descLen: null };
  }
  const end = txt.indexOf('\n---', 3);
  if (end < 0) {
    problems.push('frontmatter 没有用 --- 闭合');
    return { dir, problems, descLen: null };
  }
  const fm = txt.slice(3, end).replace(/^\n/, '');
  const { values, errors } = lintFrontmatter(fm);

  for (const e of errors) {
    problems.push(`YAML 解析失败 [${e.key}]: ${e.msg}（line ${e.line}${e.col ? `, col ${e.col}` : ''}）`);
  }

  if (!('name' in values)) {
    problems.push('缺少 name');
  } else {
    if (!/^[a-z0-9-]+$/.test(values.name)) problems.push(`name 不是 kebab-case: "${values.name}"`);
    if (values.name.length > NAME_LIMIT) problems.push(`name 长度 ${values.name.length} > ${NAME_LIMIT}`);
    if (values.name !== dir) problems.push(`name "${values.name}" 与目录名 "${dir}" 不一致`);
  }

  let descLen = null;
  if (!('description' in values)) {
    // 若是 YAML 解析失败导致没取到 description，就不重复报“缺少”
    if (errors.length === 0) problems.push('缺少 description');
  } else {
    descLen = values.description.length;
    if (descLen === 0) problems.push('description 为空');
    if (descLen > DESC_LIMIT) problems.push(`description 长度 ${descLen} > ${DESC_LIMIT}`);
  }

  return { dir, problems, descLen };
}

function main() {
  if (!existsSync(SKILLS_DIR)) {
    console.error(`找不到 skills 目录: ${SKILLS_DIR}`);
    process.exit(2);
  }
  const dirs = readdirSync(SKILLS_DIR)
    .filter((d) => existsSync(join(SKILLS_DIR, d, 'SKILL.md')))
    .sort();

  let failed = 0;
  console.log(`校验 ${dirs.length} 个 skill 的 SKILL.md frontmatter\n`);
  console.log(`${'skill'.padEnd(22)} ${'状态'.padEnd(4)} ${'desc'.padStart(6)} / ${DESC_LIMIT}`);
  console.log('-'.repeat(50));
  for (const dir of dirs) {
    const { problems, descLen } = check(dir);
    const ok = problems.length === 0;
    if (!ok) failed++;
    const lenStr = descLen == null ? '  --' : String(descLen).padStart(6);
    console.log(`${dir.padEnd(22)} ${ok ? '✅' : '❌'}   ${lenStr}`);
    for (const p of problems) console.log(`${' '.repeat(24)}↳ ${p}`);
  }
  console.log('-'.repeat(50));
  if (failed) {
    console.log(`\n❌ ${failed}/${dirs.length} 个 skill 有问题，需要修复后才能发布。`);
    process.exit(1);
  }
  console.log(`\n✅ 全部 ${dirs.length} 个 skill 通过校验。`);
}

main();

// 最小 cron 解析/匹配（5 段：分 时 日 月 周）。
//
// 只实现标准写法，不做 @daily 之类的别名：
//   *       任意
//   5       具体值
//   1-5     区间
//   */15    步进
//   1,3,5   列表（列表项可以是区间或步进）
// 周字段 0/7 = 周日，支持 0-7；日与周同时被限制时按 cron 惯例取「或」。
//
// 匹配精度到分钟：调度器每 30 秒 tick 一次，靠 minuteKey 去重，不会因为
// 一次 tick 落在同一分钟里而重复触发。

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 7 },
];

function parseField(text, field) {
  const out = new Set();
  const parts = String(text).split(',');
  if (!parts.length) throw new Error(field.name + ' 字段为空');
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) throw new Error(field.name + ' 字段有空项');
    let step = 1;
    let range = part;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      range = part.slice(0, slash);
      const stepText = part.slice(slash + 1);
      if (!/^\d+$/.test(stepText)) throw new Error(field.name + ' 的步进必须是数字：' + part);
      step = Number(stepText);
      if (step < 1) throw new Error(field.name + ' 的步进必须 ≥ 1：' + part);
    }
    let from;
    let to;
    if (range === '*') {
      from = field.min;
      to = field.max;
    } else {
      const dash = range.indexOf('-');
      if (dash >= 0) {
        from = Number(range.slice(0, dash));
        to = Number(range.slice(dash + 1));
      } else {
        if (!/^\d+$/.test(range)) throw new Error(field.name + ' 含非法值：' + part);
        from = Number(range);
        to = slash >= 0 ? field.max : from;
      }
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(field.name + ' 含非法值：' + part);
    if (from < field.min || to > field.max || from > to) {
      throw new Error(field.name + ' 超出范围 ' + field.min + '-' + field.max + '：' + part);
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  if (!out.size) throw new Error(field.name + ' 字段没有有效值');
  return out;
}

function parse(expression) {
  const text = String(expression == null ? '' : expression).trim().replace(/\s+/g, ' ');
  if (!text) throw new Error('cron 表达式不能为空');
  const parts = text.split(' ');
  if (parts.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周（当前 ' + parts.length + ' 段）');
  const [minute, hour, dom, month, dow] = parts.map((part, i) => parseField(part, FIELDS[i]));
  return { minute, hour, dom, month, dow, raw: text, domRestricted: parts[2] !== '*', dowRestricted: parts[4] !== '*' };
}

function matches(parsed, date) {
  if (!parsed) return false;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();
  if (!parsed.minute.has(minute) || !parsed.hour.has(hour) || !parsed.month.has(month)) return false;
  const domOk = parsed.dom.has(dom);
  const dowOk = parsed.dow.has(dow) || (dow === 0 && parsed.dow.has(7));
  // cron 惯例：日与周都写了具体值时是「或」，只写一个时是「与」
  if (parsed.domRestricted && parsed.dowRestricted) return domOk || dowOk;
  if (parsed.domRestricted) return domOk;
  if (parsed.dowRestricted) return dowOk;
  return true;
}

// 下一次触发时间（本地时间，精确到分钟）。最多向前找 366 天。
function nextRun(parsed, from = Date.now()) {
  const start = new Date(from);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    const at = new Date(start.getTime() + i * 60000);
    if (matches(parsed, at)) return at.getTime();
  }
  return 0;
}

const DOW_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function listOf(set, max = 4) {
  const values = [...set].sort((a, b) => a - b);
  if (values.length > max) return values.slice(0, max).join(',') + '…';
  return values.join(',');
}

// 人话描述：覆盖常见形态，认不出来就回显原表达式（不编造）
function describe(parsed) {
  if (!parsed) return '';
  const { minute, hour, dom, month, dow, domRestricted, dowRestricted } = parsed;
  const pad = n => String(n).padStart(2, '0');
  const everyMinute = minute.size === 60;
  const everyHour = hour.size === 24;
  const single = set => set.size === 1 ? [...set][0] : null;
  const minutesList = listOf(minute);
  const hourSingle = single(hour);
  const minuteSingle = single(minute);
  let when = '';
  if (everyMinute && everyHour) when = '每分钟';
  else if (minute.size === 1 && everyHour) when = '每小时的第 ' + minuteSingle + ' 分';
  else if (minute.size === 1 && hour.size === 1) when = pad(hourSingle) + ':' + pad(minuteSingle);
  else if (everyMinute && hour.size === 1) when = pad(hourSingle) + ' 点内每分钟';
  else if (hour.size === 1) when = pad(hourSingle) + ' 点的 ' + minutesList + ' 分';
  else if (everyHour) when = '每小时 ' + minutesList + ' 分';
  else if (Array.isArray([...minute]) && minute.size === 1) when = listOf(hour) + ' 点的 ' + minuteSingle + ' 分';
  else when = '（分 ' + minutesList + ' · 时 ' + listOf(hour) + '）';
  const extras = [];
  if (dowRestricted) {
    const days = [...dow].map(d => DOW_NAMES[d % 7]).sort();
    extras.push(days.length >= 5 && new Set(days).size >= 5 ? '指定星期' : days.join('、'));
  }
  if (domRestricted) extras.push('每月 ' + listOf(dom) + ' 日');
  if (month.size !== 12) extras.push(listOf(month) + ' 月');
  return when + (extras.length ? ' · ' + extras.join(' · ') : '');
}

// 去重键：同一分钟内只触发一次
function minuteKey(now) {
  const d = new Date(now);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// 常用频率的快捷构造（UI 的「工作日 9 点」等按钮直接用这些）
const PRESETS = {
  hourly: '0 * * * *',
  weekdays9: '0 9 * * 1-5',
  daily9: '0 9 * * *',
  weeklyMon9: '0 9 * * 1',
  monthly1st9: '0 9 1 * *',
  every15: '*/15 * * * *',
  every30: '*/30 * * * *',
};

function validate(expression) {
  try {
    const parsed = parse(expression);
    return { ok: true, description: describe(parsed), next: nextRun(parsed), raw: parsed.raw };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { parse, matches, nextRun, describe, minuteKey, validate, PRESETS };

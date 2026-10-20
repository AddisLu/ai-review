// Offline mental-math generator (no AI needed, instant). Answers are exact
// fractions so 3/2, 1又1/2 and 1.5 are all accepted.
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const lcm = (a, b) => a / gcd(a, b) * b;
const R = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class Frac {
  constructor(n, d = 1) {
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(n, d) || 1;
    this.n = n / g; this.d = d / g;
  }
  add(o) { return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Frac(this.n * o.n, this.d * o.d); }
  div(o) { return new Frac(this.n * o.d, this.d * o.n); }
  eq(o) { return o && this.n === o.n && this.d === o.d; }
  tex() {
    if (this.d === 1) return String(this.n);
    const w = Math.trunc(this.n / this.d), r = Math.abs(this.n % this.d);
    return w ? `${w}\\frac{${r}}{${this.d}}` : `\\frac{${this.n}}{${this.d}}`;
  }
  text() {
    if (this.d === 1) return String(this.n);
    const w = Math.trunc(this.n / this.d), r = Math.abs(this.n % this.d);
    return w ? `${w}又${r}/${this.d}` : `${this.n}/${this.d}`;
  }
}

export function parseAnswer(s) {
  s = String(s || '').replace(/\s+/g, '').replace(/[，,]/g, '');
  let m;
  try {
    if ((m = s.match(/^(-?\d+)又(\d+)\/(\d+)$/))) return new Frac(Number(m[1]) * Number(m[3]) + Number(m[2]), Number(m[3]));
    if ((m = s.match(/^(-?\d+)\/(\d+)$/))) return Number(m[2]) ? new Frac(Number(m[1]), Number(m[2])) : null;
    if ((m = s.match(/^(-?\d+)(?:\.(\d+))?$/))) {
      const dec = m[2] || '';
      return new Frac(Number(m[1] + dec), 10 ** dec.length);
    }
  } catch { /* fallthrough */ }
  return null;
}

const dec = (x) => { const s = String(x); const p = s.split('.'); return new Frac(Number(p.join('')), 10 ** ((p[1] || '').length)); };

const GEN = {
  add_sub() {
    const a = R(100, 9999), b = R(100, 999);
    return Math.random() < 0.5 ? [`${a} + ${b}`, new Frac(a + b)] : [`${a + b} - ${b}`, new Frac(a)];
  },
  mul_table() {
    const t = R(0, 2);
    if (t === 0) { const a = R(2, 9), b = R(2, 9); return [`${a} \\times ${b}`, new Frac(a * b)]; }
    const a = R(11, 99), b = R(2, 9); return [`${a} \\times ${b}`, new Frac(a * b)];
  },
  div_simple() {
    const b = R(2, 9), q = R(2, 30);
    return [`${b * q} \\div ${b}`, new Frac(q)];
  },
  frac_same() {
    const d = R(3, 12), a = R(1, d - 1), c = R(1, d - 1);
    if (Math.random() < 0.5 && a + c <= d) return [`\\frac{${a}}{${d}} + \\frac{${c}}{${d}}`, new Frac(a + c, d)];
    const [x, y] = a >= c ? [a, c] : [c, a];
    return [`\\frac{${x}}{${d}} - \\frac{${y}}{${d}}`, new Frac(x - y, d)];
  },
  time_len() {
    const t = R(0, 3);
    if (t === 0) { const h = R(1, 5); return [`${h} \\text{ 小時} = ? \\text{ 分}`, new Frac(h * 60)]; }
    if (t === 1) { const m = R(1, 9); return [`${m} \\text{ 分} = ? \\text{ 秒}`, new Frac(m * 60)]; }
    if (t === 2) { const m = R(1, 9), c = R(1, 99); return [`${m} \\text{ 公尺 } ${c} \\text{ 公分} = ? \\text{ 公分}`, new Frac(m * 100 + c)]; }
    const k = R(1, 9); return [`${k} \\text{ 公斤} = ? \\text{ 公克}`, new Frac(k * 1000)];
  },
  int() {
    const t = R(0, 3);
    if (t === 0) { const a = R(12, 99), b = R(11, 49); return [`${a} \\times ${b}`, new Frac(a * b)]; }
    if (t === 1) { const b = R(12, 48), q = R(12, 60); return [`${b * q} \\div ${b}`, new Frac(q)]; }
    if (t === 2) { const a = R(10, 99), b = R(2, 9), c = R(2, 12); return [`${a} + ${b} \\times ${c}`, new Frac(a + b * c)]; }
    const a = R(2, 9), b = R(10, 40), c = R(2, 9); return [`(${b} - ${c}) \\times ${a}`, new Frac((b - c) * a)];
  },
  frac_add() {
    const d1 = R(2, 9), d2 = R(2, 9), n1 = R(1, d1 - 1 || 1), n2 = R(1, d2 - 1 || 1);
    const a = new Frac(n1, d1), b = new Frac(n2, d2);
    if (Math.random() < 0.5 || a.sub(b).n < 0) return [`\\frac{${n1}}{${d1}} + \\frac{${n2}}{${d2}}`, a.add(b)];
    return [`\\frac{${n1}}{${d1}} - \\frac{${n2}}{${d2}}`, a.sub(b)];
  },
  frac_mul() {
    const a = new Frac(R(1, 8), R(2, 9)), b = new Frac(R(1, 8), R(2, 9));
    if (Math.random() < 0.5) return [`${a.tex()} \\times ${b.tex()}`, a.mul(b)];
    const w = R(2, 12);
    return Math.random() < 0.5 ? [`${a.tex()} \\div ${b.tex()}`, a.div(b)] : [`${w} \\div ${b.tex()}`, new Frac(w).div(b)];
  },
  decimal() {
    const t = R(0, 2);
    if (t === 0) { const a = R(11, 99) / 10, b = R(2, 9) / 10; return [`${a} \\times ${b}`, dec(a).mul(dec(b))]; }
    if (t === 1) { const b = pick([0.2, 0.4, 0.5, 0.8, 1.2, 2.5]), q = R(2, 30); return [`${+(b * q).toFixed(2)} \\div ${b}`, new Frac(q)]; }
    const a = R(101, 999) / 100, b = R(11, 99) / 10; return [`${a} + ${b}`, dec(a).add(dec(b))];
  },
  percent() {
    const t = R(0, 2);
    if (t === 0) { const p = pick([10, 20, 25, 30, 40, 50, 75, 15, 5]), x = R(2, 40) * 20; return [`${x} \\text{ 的 } ${p}\\%`, new Frac(x * p, 100)]; }
    if (t === 1) { const p = R(1, 99); return [`${(p / 100).toFixed(2).replace(/0$/, '')} = ?\\%`, new Frac(p)]; }
    const p = pick([20, 25, 50, 75, 10]), x = R(2, 30) * 4; return [`\\text{打 ${10 - p / 10} 折，原價 ${x * 10} 元，售價？}`, new Frac(x * 10 * (100 - p), 100)];
  },
  gcd_lcm() {
    const k = R(2, 12), a = k * R(1, 9), b = k * R(1, 9);
    if (a === b) return GEN.gcd_lcm();
    return Math.random() < 0.5 ? [`(${a}, ${b}) \\text{ 的最大公因數}`, new Frac(gcd(a, b))] : [`[${a}, ${b}] \\text{ 的最小公倍數}`, new Frac(lcm(a, b))];
  },
  unit() {
    const t = R(0, 5);
    const x = R(1, 99) / 10;
    if (t === 0) return [`${x} \\text{ 公尺} = ? \\text{ 公分}`, dec(x).mul(new Frac(100))];
    if (t === 1) return [`${x} \\text{ 公升} = ? \\text{ 毫升}`, dec(x).mul(new Frac(1000))];
    if (t === 2) { const h = pick([0.25, 0.5, 0.75, 1.2, 1.5, 2.25]); return [`${h} \\text{ 小時} = ? \\text{ 分}`, dec(h).mul(new Frac(60))]; }
    if (t === 3) { const a = R(1, 9); return [`${a} \\text{ 公頃} = ? \\text{ 平方公尺}`, new Frac(a * 10000)]; }
    if (t === 4) { const k = R(1, 9) * 100; return [`${k} \\text{ 公克} = ? \\text{ 公斤}`, new Frac(k, 1000)]; }
    const c = R(1, 5); return [`${c} \\text{ 立方公尺} = ? \\text{ 立方公分}`, new Frac(c * 1000000)];
  },
  speed() {
    const v = pick([4, 5, 12, 15, 40, 60, 72, 80, 90]), t = pick([0.5, 1.5, 2, 2.5, 3, 4]);
    const k = R(0, 2);
    if (k === 0) return [`\\text{時速 ${v} 公里，${t} 小時走幾公里？}`, dec(t).mul(new Frac(v))];
    if (k === 1) return [`\\text{${+(v * t).toFixed(1)} 公里，走了 ${t} 小時，時速？}`, new Frac(v)];
    return [`\\text{時速 ${v} 公里走 ${+(v * t).toFixed(1)} 公里，要幾小時？}`, dec(t)];
  },
  circle() {
    const r = R(1, 10);
    return Math.random() < 0.5 ? [`\\text{半徑 ${r} 公分的圓面積（圓周率 3.14）}`, dec(3.14).mul(new Frac(r * r))]
      : [`\\text{直徑 ${2 * r} 公分的圓周長（圓周率 3.14）}`, dec(3.14).mul(new Frac(2 * r))];
  },
  ratio() {
    const a = R(1, 9), b = R(1, 9), k = R(2, 9);
    if (a === b) return GEN.ratio();
    return Math.random() < 0.5 ? [`${a * k} : ${b * k} \\text{ 的比值}`, new Frac(a, b)] : [`${a} : ${b} = ${a * k} : ?`, new Frac(b * k)];
  },
};

// [kind, label, lowest grade, highest grade]
export const DRILLS = [
  ['mix', '- 綜合大亂鬥', 3, 6],
  ['add_sub', '- 大數加減', 3, 4], ['mul_table', '- 乘法', 3, 4], ['div_simple', '- 除法', 3, 4],
  ['frac_same', '- 同分母分數', 3, 4], ['time_len', '- 時間與長度', 3, 4],
  ['int', '- 整數四則', 4, 6], ['frac_add', '- 分數加減', 5, 6], ['frac_mul', '- 分數乘除', 5, 6],
  ['decimal', '- 小數計算', 5, 6], ['percent', '- 百分率・折扣', 5, 6], ['gcd_lcm', '- 因數倍數', 5, 6],
  ['unit', '- 單位換算', 5, 6], ['speed', '- 速率', 6, 6], ['circle', '- 圓面積周長', 6, 6], ['ratio', '- 比與比值', 6, 6],
];

export function drillsFor(grade) {
  const g = Number(grade) || 6;
  return DRILLS.filter((d) => d[2] <= g && g <= d[3]);
}

export function makeProblem(kind, grade = 6) {
  const pool = drillsFor(grade).map((d) => d[0]).filter((k) => k !== 'mix');
  const k = kind === 'mix' ? pick(pool.length ? pool : Object.keys(GEN)) : kind;
  const [tex, ans] = GEN[k]();
  return { kind: k, tex, ans };
}

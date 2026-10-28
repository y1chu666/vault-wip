// 敏感取值的界面遮罩。
//
// 频道标识、指纹与中继地址一旦进入截图或旁人视线即算泄露，而整段遮住又看不出字段
// 长度、也难判断是否粘贴完整。留首尾各四位是两者之间固定的折中；规则只放在这一处，
// 界面各处共用，免得同一份取值在这里遮、在那里露。
const KEEP = 4;

/**
 * 把敏感取值遮去中段，只留首尾各四位。
 *
 * 长度不超过八位时整段遮掉：此时留首尾等于把取值原样露出。星号与原文等长，遮罩与
 * 展开之间字段宽度不变，界面不会跳动。
 */
export function maskSecret(value: string): string {
  if (value.length <= KEEP * 2) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, KEEP)}${"*".repeat(value.length - KEEP * 2)}${value.slice(-KEEP)}`;
}

/**
 * 域名单段的遮罩：留出足以辨认的字符，其余按段长档位遮住。
 *
 * 地址要用来分辨是哪台中继、哪台服务器，整段遮死就失去用途；但公开出去又要防旁人
 * 一眼读全。因此按段长分档：长段留首尾两位，中等段留首尾一位，一两位的短段只剩首
 * 字符或一个星号。这一档只挡扫一眼，挡不住由首尾反推全名。
 */
function maskLabel(label: string): string {
  if (label.length <= 1) {
    return "*";
  }
  if (label.length === 2) {
    return `${label.slice(0, 1)}*`;
  }
  if (label.length <= 5) {
    return `${label.slice(0, 1)}${"*".repeat(label.length - 2)}${label.slice(-1)}`;
  }
  return `${label.slice(0, 2)}${"*".repeat(label.length - 4)}${label.slice(-2)}`;
}

/** IPv4 的四个数字段，用于把它与域名区分开。 */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * 主机部分：IPv4 留首末网段，IPv6 留首尾组，域名逐段遮罩并保留顶级域。
 *
 * IPv4 的首段看得出是内网还是公网，末段认得出是哪台；中间两段没有信息量，统一遮掉。
 * 域名的顶级域是公共后缀，不含身份信息，始终原样保留。
 */
function maskHost(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    const groups = host.slice(1, -1).split(":");
    const first = groups[0];
    const last = groups[groups.length - 1];
    if (groups.length < 3 || first === "" || last === "") {
      return "[****]";
    }
    return `[${first}:****:${last}]`;
  }
  if (IPV4.test(host)) {
    const parts = host.split(".");
    return `${parts[0]}.***.***.${parts[3]}`;
  }
  const labels = host.split(".");
  return labels
    .map((label, index) => (index === labels.length - 1 && labels.length > 1 ? label : maskLabel(label)))
    .join(".");
}

/** 主机名之外不该出现的字符；命中即视为不是地址。 */
const HOST_CHARS = /[^A-Za-z0-9._:\-[\]]/;

/** 地址的结构：协议、主机与端口部分，以及其后的路径、查询或片段。 */
const URL_PARTS = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)?([^/?#]*)([/?#].*)?$/;

/**
 * 中继地址的遮罩：保留协议、顶级域与结构分隔符，按主机类型遮住其余部分。
 *
 * 端口固定遮成四位，不透露位数；路径里常带仓库名或组织名，比域名更能定位到人，
 * 因此只留首个分隔符。解析不出结构的地址退回整段遮罩，免得遮漏一处。
 */
export function maskUrl(value: string): string {
  const match = URL_PARTS.exec(value);
  if (match === null) {
    return maskSecret(value);
  }
  const scheme = match[1] ?? "";
  const authority = match[2] ?? "";
  const rest = match[3];
  // 含空白的多半不是地址而是随手写的一行字，按普通取值整段遮住。
  if (authority === "" || /\s/.test(authority)) {
    return maskSecret(value);
  }
  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? "" : `${maskSecret(authority.slice(0, at))}@`;
  const hostAndPort = authority.slice(at + 1);

  // IPv6 地址自带冒号，端口只可能出现在方括号之后，因此从方括号末尾往后找。
  const closing = hostAndPort.startsWith("[") ? hostAndPort.indexOf("]") : -1;
  const colon = hostAndPort.lastIndexOf(":");
  const hasPort = colon !== -1 && colon > closing;
  const host = hasPort ? hostAndPort.slice(0, colon) : hostAndPort;
  const port = hasPort ? ":****" : "";
  // 主机名只由地址允许的字符组成；出现别的字符（例如随手写的中文）即不当作地址。
  if (host === "" || HOST_CHARS.test(host)) {
    return maskSecret(value);
  }

  const tail = rest === undefined ? "" : `${rest.slice(0, 1)}****`;
  return `${scheme}${userinfo}${maskHost(host)}${port}${tail}`;
}

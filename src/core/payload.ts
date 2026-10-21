// 本模块定义状态记录的内容格式。
//
// 内容是加密后再交给中继的，读到的只会是同仓库的其他设备，因此格式可以只为自身需要服务：
// 改动文件总数、归一后的文件名清单，以及两类需要单独说明的文件（疑似假冲突、冲突残留）。
// 清单长度有上限，超出时只上报数量并标记截断，免得一条记录超过中继允许的大小。
import { decodeText, encodeText } from "./text.js";
import { t } from "./i18n.js";

/** 单条记录携带的文件名上限。 */
export const MAX_PATHS = 1000;

/** 路径长度上限。 */
const MAX_PATH_LENGTH = 4096;

/** 设备名称长度上限，与配置里的上限一致。 */
const MAX_LABEL_LENGTH = 64;

/** 改动类型到单字母的映射；未知类型留空，界面按「其他」处理。 */
const KIND_CODES: Readonly<Record<string, string>> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  unmerged: "U",
  untracked: "?",
};

/** 允许出现在记录里的改动类型代码。 */
export const CHANGE_CODES = ["A", "M", "D", "R", "U", "?", ""] as const;

/** 状态记录的内容。 */
export interface StatusPayload {
  /** 本设备名称，由本设备自己写下；中继看不到它。 */
  readonly label: string;
  /** 改动文件总数，可能大于清单长度。 */
  readonly count: number;
  /** 清单是否因超长而被截断。 */
  readonly truncated: boolean;
  /** 归一后的文件名清单。 */
  readonly paths: readonly string[];
  /**
   * 与 paths 一一对应的改动类型：A 新增、M 修改、D 删除、R 重命名、U 冲突、? 未跟踪。
   *
   * 空串表示类型未知，只有旧版本写下的记录才会出现。
   */
  readonly kinds: readonly string[];
  /** 疑似假冲突的文件：差异只是行尾或权限位。 */
  readonly suspectFiles: readonly string[];
  /** 检出冲突残留的文件。 */
  readonly conflictFiles: readonly string[];
}

/** 内容不合规。 */
export class StatusPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatusPayloadError";
  }
}

/** 由采集结果构造内容，并按上限截断文件名清单。 */
export function buildStatusPayload(collected: {
  readonly label: string;
  readonly changes: readonly { readonly path: string; readonly kind: string }[];
  readonly suspectFiles: readonly string[];
  readonly conflictFiles: readonly string[];
}): StatusPayload {
  const seen = new Set<string>();
  const paths: string[] = [];
  const kinds: string[] = [];
  for (const change of collected.changes) {
    if (seen.has(change.path)) {
      continue;
    }
    seen.add(change.path);
    paths.push(change.path);
    kinds.push(KIND_CODES[change.kind] ?? "");
  }
  const truncated = paths.length > MAX_PATHS;

  return {
    label: collected.label,
    count: paths.length,
    truncated,
    paths: truncated ? paths.slice(0, MAX_PATHS) : paths,
    kinds: truncated ? kinds.slice(0, MAX_PATHS) : kinds,
    suspectFiles: [...new Set(collected.suspectFiles)],
    conflictFiles: [...new Set(collected.conflictFiles)],
  };
}

/** 把内容编码为交给加密模块的字节。 */
export function encodeStatusPayload(payload: StatusPayload): Uint8Array {
  return encodeText(
    JSON.stringify({
      label: payload.label,
      count: payload.count,
      truncated: payload.truncated,
      paths: payload.paths,
      kinds: payload.kinds,
      suspectFiles: payload.suspectFiles,
      conflictFiles: payload.conflictFiles,
    }),
  );
}

/**
 * 解析内容。
 *
 * 内容来自同仓库的其他设备，且已被本端密钥解开，因此这里仍然做严格校验：
 * 字段缺失或类型不符说明版本已经错位，此时宁可让这一条读不出来，也不要按残缺内容推断。
 */
export function decodeStatusPayload(bytes: Uint8Array): StatusPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(decodeText(bytes));
  } catch {
    throw new StatusPayloadError(t("记录内容不是合法的 JSON"));
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StatusPayloadError(t("记录内容应当是一个对象"));
  }

  const table = raw as Record<string, unknown>;
  const allowed = ["label", "count", "truncated", "paths", "kinds", "suspectFiles", "conflictFiles"];
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) {
      throw new StatusPayloadError(t("记录内容中不认识的字段：{field}", { field: key }));
    }
  }

  const label = table["label"];
  if (typeof label !== "string") {
    throw new StatusPayloadError(t("记录内容中的设备名称不合规"));
  }
  if (label.length > MAX_LABEL_LENGTH || hasControlCharacter(label)) {
    throw new StatusPayloadError(t("记录内容中的设备名称不合规"));
  }

  const count = table["count"];
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new StatusPayloadError(t("记录内容中的改动文件数不合规"));
  }
  const truncated = table["truncated"];
  if (typeof truncated !== "boolean") {
    throw new StatusPayloadError(t("记录内容中的截断标记不合规"));
  }

  const paths = readPaths(table["paths"], "paths");
  if (count < paths.length) {
    throw new StatusPayloadError(t("记录内容中的改动文件数小于清单长度"));
  }

  return {
    label,
    count,
    truncated,
    paths,
    kinds: readKinds(table["kinds"], paths.length),
    suspectFiles: readPaths(table["suspectFiles"], "suspectFiles"),
    conflictFiles: readPaths(table["conflictFiles"], "conflictFiles"),
  };
}

/** 名称里出现控制字符会破坏界面排版，也会让日志难以阅读。 */
function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function readPaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new StatusPayloadError(t("记录内容中的 {field} 应当是数组", { field }));
  }
  if (value.length > MAX_PATHS) {
    throw new StatusPayloadError(t("记录内容中的 {field} 超过 {limit} 条", { field, limit: MAX_PATHS }));
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new StatusPayloadError(t("记录内容中的 {field} 含有非字符串条目", { field }));
    }
    if (entry === "" || entry.length > MAX_PATH_LENGTH || entry.includes("\u0000")) {
      throw new StatusPayloadError(t("记录内容中的 {field} 含有不合规的路径", { field }));
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      paths.push(entry);
    }
  }
  return paths;
}

/**
 * 读取与路径一一对应的改动类型。
 *
 * 旧版本写下的记录没有这一项：按未知处理，路径照常显示，不让整条记录作废。
 */
function readKinds(value: unknown, expectedLength: number): string[] {
  if (value === undefined) {
    return Array.from({ length: expectedLength }, () => "");
  }
  if (!Array.isArray(value)) {
    throw new StatusPayloadError(t("记录内容中的改动类型应当是数组"));
  }
  if (value.length !== expectedLength) {
    throw new StatusPayloadError(t("记录内容中的改动类型与文件清单长度不一致"));
  }

  return value.map((entry) => {
    if (typeof entry !== "string" || !(CHANGE_CODES as readonly string[]).includes(entry)) {
      throw new StatusPayloadError(t("记录内容中含有不认识的改动类型"));
    }
    return entry;
  });
}

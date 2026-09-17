/**
 * 极简 JSON Schema 校验器（仅覆盖本仓库用到的 draft-07 子集）。
 *
 * 之所以不引入 ajv：备份工具需要能在无 node_modules 的环境下运行
 * （例如只恢复了备份文件的裸机），保持零依赖更可靠。
 *
 * 支持：type、required、properties、items、additionalProperties、
 *       enum/const、minimum、minLength、oneOf、$ref（同文档内）。
 */

function resolveRef(schema, root) {
  if (!schema || typeof schema !== 'object') return schema;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    return schema.$ref
      .slice(2)
      .split('/')
      .reduce((node, key) => (node ? node[key] : undefined), root);
  }
  return schema;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

/**
 * @returns {string[]} 错误描述数组，空数组表示通过
 */
export function validate(value, schema, root = schema, pointer = '$') {
  const errors = [];
  const resolved = resolveRef(schema, root);
  if (!resolved || typeof resolved !== 'object') return errors;

  if (resolved.type) {
    const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${pointer}: 期望类型 ${types.join('|')}，实际 ${typeOf(value)}`);
      return errors;
    }
  }

  if (resolved.const !== undefined && value !== resolved.const) {
    errors.push(`${pointer}: 期望常量 ${JSON.stringify(resolved.const)}，实际 ${JSON.stringify(value)}`);
  }
  if (resolved.enum && !resolved.enum.includes(value)) {
    errors.push(`${pointer}: 不在允许值 ${JSON.stringify(resolved.enum)} 内`);
  }
  if (typeof value === 'string' && typeof resolved.minLength === 'number' && value.length < resolved.minLength) {
    errors.push(`${pointer}: 字符串长度小于 ${resolved.minLength}`);
  }
  if (typeof value === 'number' && typeof resolved.minimum === 'number' && value < resolved.minimum) {
    errors.push(`${pointer}: 数值小于 ${resolved.minimum}`);
  }

  if (resolved.oneOf) {
    const matched = resolved.oneOf.filter((sub) => validate(value, sub, root, pointer).length === 0);
    if (matched.length !== 1) {
      errors.push(`${pointer}: oneOf 需恰好匹配一项，实际匹配 ${matched.length} 项`);
    }
  }

  if (matchesType(value, 'object') && value !== null) {
    for (const key of resolved.required || []) {
      if (!(key in value)) errors.push(`${pointer}: 缺少必需字段 ${key}`);
    }
    const props = resolved.properties || {};
    for (const [key, child] of Object.entries(value)) {
      if (props[key]) {
        errors.push(...validate(child, props[key], root, `${pointer}.${key}`));
      } else if (resolved.additionalProperties === false) {
        errors.push(`${pointer}: 存在未声明的字段 ${key}`);
      } else if (resolved.additionalProperties && typeof resolved.additionalProperties === 'object') {
        errors.push(...validate(child, resolved.additionalProperties, root, `${pointer}.${key}`));
      }
    }
  }

  if (Array.isArray(value) && resolved.items) {
    value.forEach((item, index) => {
      errors.push(...validate(item, resolved.items, root, `${pointer}[${index}]`));
    });
  }

  return errors;
}

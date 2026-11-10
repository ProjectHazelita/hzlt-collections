import { DomainError } from './errors.js';
export function webUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError(400, 'VALIDATION_ERROR', '网址无效。');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.toString().length > 2048
  )
    throw new DomainError(
      400,
      'VALIDATION_ERROR',
      '网址须为不含账号密码的 http(s) 地址，最多 2048 个字符。',
    );
  return url.toString();
}

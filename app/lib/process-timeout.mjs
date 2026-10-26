/**
 * @param {{ code?: string | number | null; killed?: boolean; signal?: string | null }} error
 */
export function isProcessTimeout(error) {
  return error.code === "ETIMEDOUT" || (error.killed === true && error.signal === "SIGTERM");
}

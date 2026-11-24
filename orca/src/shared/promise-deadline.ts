export function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) {
    // Why: this caller stops observing the promise, so its late rejection must not go unhandled.
    promise.catch(() => {})
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

// https://github.com/rxaviers/async-pool/blob/master/lib/es9.js
export async function* asyncPool<IN, OUT>(concurrency: number, iterable: readonly IN[], iterator_fn: (generator: IN, iterable: readonly IN[]) => Promise<OUT>): AsyncIterableIterator<OUT> {
    const executing = new Set();
    async function consume() {
        // @ts-ignore
        const [promise, value] = await Promise.race(executing);
        executing.delete(promise);
        return value;
    }
  
    for (const item of iterable) {
        const promise: any = (async () => await iterator_fn(item, iterable))().then((value) => [
            promise,
            value,
        ]);
        executing.add(promise);
        if (executing.size >= concurrency) {
            yield await consume();
        }
    }
  
    while (executing.size) {
        yield await consume();
    }
}
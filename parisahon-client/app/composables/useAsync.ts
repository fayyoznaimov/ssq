// While > 0, run() calls do not touch isLoading: a live refresh (useLive)
// reloads data in place, without spinners or skeletons flashing.
let silentDepth = 0;

/** runs fn(); the useAsync loads it starts synchronously are silent */
export function silently<T>(fn: () => T): T {
    silentDepth++;
    try {
        return fn();
    } finally {
        silentDepth--;
    }
}

export function useAsync<T>(initialData: Partial<T> | null = null) {
    const isLoading = ref(false);
    const isLoadingMap = reactive<Record<string | number, boolean>>({});
    const data = ref<Partial<T> | null>(initialData) as Ref<T>;
    const error = ref<any>(null);

    const run = async (promise: Promise<T>, transform = (data: T) => data) => {
        const silent = silentDepth > 0;
        if (!silent) isLoading.value = true;
        try {
            const result = await promise;
            data.value = transform(result);
        } catch (err) {
            error.value = err;
        } finally {
            if (!silent) isLoading.value = false;
        }
    };

    const runAsync = async (promise: Promise<T>) => {
        const silent = silentDepth > 0;
        if (!silent) isLoading.value = true;
        try {
            const result = await promise;
            data.value = result;
            return data.value;
        } catch (err) {
            error.value = err;
            throw err;
        } finally {
            if (!silent) isLoading.value = false;
        }
    };

    const runWithId = async (promise: Promise<T>, id: string | number) => {
        const silent = silentDepth > 0;
        if (!silent) isLoading.value = true;
        isLoadingMap[id] = true;
        try {
            const result = await promise;
            data.value = result;
            return data.value;
        } catch (err) {
            error.value = err;
            throw err;
        } finally {
            if (!silent) isLoading.value = false;
            isLoadingMap[id] = false;
            delete isLoadingMap[id];
        }
    };

    return { run, isLoading, error, data, runAsync, runWithId, isLoadingMap };
}

export function useInfiniteQuery<T>(initialData: Partial<T> | null = null, direction: string = 'top') {
    const isLoading = ref(false);
    const data = ref<{pages: (Partial<T> | null)[]}>({pages: [initialData]}) as Ref<{pages: T[]}>;
    const error = ref<any>(null);
    let hasInitialData = initialData != null;

    const run = async (promise: Promise<T>) => {
        const silent = silentDepth > 0;
        if (!silent) isLoading.value = true;
        try {
            const result = await promise;
            if (hasInitialData) {
                data.value = { pages: [] };
                hasInitialData = false;
            }
            if (direction === 'top') data.value.pages.unshift(result);
            else data.value.pages.push(result);
        } catch (err) {
            error.value = err;
        } finally {
            if (!silent) isLoading.value = false;
        }
    };

    const runAsync = async (promise: Promise<T>) => {
        const silent = silentDepth > 0;
        if (!silent) isLoading.value = true;
        try {
            const result = await promise;
            if (hasInitialData) {
                data.value = { pages: [] };
                hasInitialData = false;
            }
            if (direction === 'top') data.value.pages.unshift(result);
            else data.value.pages.push(result);
            return result;
        } catch (err) {
            error.value = err;
            throw err;
        } finally {
            if (!silent) isLoading.value = false;
        }
    };

    function reset() {
        data.value = { pages: [] };
        hasInitialData = false;
    }

    return { run, isLoading, error, data, runAsync, reset };
}

import type { Ref } from 'vue';
import { computed, ref, unref,watch } from 'vue';

export interface UseIntersectionObserverOptions {
    immediate?: boolean;

    root?: Ref | ComputedRef;

    rootMargin?: string;

    threshold?: number | number[];
}

export interface UseIntersectionObserverReturn {
    isSupported: Ref<boolean>;
    stop: () => void;
    isActive: Ref<boolean>;
    pause: () => void;
    resume: () => void;
}

export function useIntersectionObserver(
    target: Ref | ComputedRef | Ref[] | ComputedRef[],
    callback: IntersectionObserverCallback,
    options: UseIntersectionObserverOptions = {},
): UseIntersectionObserverReturn {
    const {
        root,
        rootMargin = '0px',
        threshold = 0.1,
        immediate = true,
    } = options;

    const isSupported = useSupported(() => window && 'IntersectionObserver' in window);
    const targets = computed(() => {
        const _target = toValue(target);
        return (Array.isArray(_target) ? _target : [_target]).map(unref).filter(Boolean);
    });

    let cleanup = () => { };
    const isActive = ref(immediate);

    const stopWatch = isSupported.value
        ? watch(
            () => [targets.value, unref(root), isActive.value] as const,
            ([targets, root]) => {
                cleanup();
                if (!isActive.value)
                    return;

                if (!targets.length)
                    return;

                const observer = new IntersectionObserver(
                    callback,
                    {
                        root: unref(root),
                        rootMargin,
                        threshold,
                    },
                );

                targets.forEach(el => el && observer.observe(el));

                cleanup = () => {
                    observer.disconnect();
                    cleanup = () => { };
                };
            },
            { immediate, flush: 'post' },
        )
        : () => { };

    const stop = () => {
        cleanup();
        stopWatch();
        isActive.value = false;
    };

    onUnmounted(stop);

    return {
        isSupported,
        isActive,
        pause() {
            cleanup();
            isActive.value = false;
        },
        resume() {
            isActive.value = true;
        },
        stop,
    };
}
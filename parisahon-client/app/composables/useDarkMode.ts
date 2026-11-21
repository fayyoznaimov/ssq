function checkDarkMode() {
    return document.documentElement.classList.contains('dark');
}

export function useDarkMode() {
    const isDarkMode = ref(checkDarkMode());
    let observer: MutationObserver;

    onMounted(() => {
        observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.attributeName === 'class') {
                    isDarkMode.value = checkDarkMode();
                }
            });
        });

        observer.observe(document.documentElement, {attributes: true});
    });

    onUnmounted(() => {
        if (observer) observer.disconnect();
    });

    return isDarkMode;
}
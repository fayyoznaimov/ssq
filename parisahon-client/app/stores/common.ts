export const useCommonStore = defineStore("common", () => {
    const notificationCount = ref(0);

    return { notificationCount };
});

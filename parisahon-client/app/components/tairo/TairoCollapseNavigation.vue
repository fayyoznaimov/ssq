<template>
    <div
        v-if="menuItems.length"
        :class="[
            !isOpen ? 'w-[80px]' : 'w-[280px]',
            isMobileOpen
                ? 'translate-x-0 lg:translate-x-0'
                : '-translate-x-full lg:translate-x-0',
        ]"
        class="dark:bg-muted-800 border-muted-200 dark:border-muted-700 fixed left-0 top-0 z-[60] flex h-full flex-col border-r bg-primary-500 transition-all duration-300"
    >
        <!--Header-->
        <slot name="header" />
        <!--Body-->
        <div
            class="slimscroll relative w-full grow overflow-y-auto no-scrollbar"
        >
            <NuxtLink
                href="/"
                class="flex items-center gap-3 bg-primary-700 py-4 dark:bg-muted-700"
                :class="!isOpen ? 'px-4' : 'px-6 pl-10'"
            >
                <Icon
                    name="ph:flower-lotus"
                    class="size-7 text-white"
                    :class="!isOpen ? 'mx-auto' : ''"
                />
                <span
                    class="text-white transition-colors duration-500 uppercase text-sm font-semibold"
                    :class="!isOpen ? 'hidden' : 'inline-block'"
                >
                    Parisa
                </span>
            </NuxtLink>
            <ul
                id="sidebar-menu"
                class="space-y-2 py-6"
                :class="!isOpen ? 'px-4' : 'px-6'"
            >
                <!--Menu item-->
                <li
                    v-for="(item, index) in menuItems"
                    :key="index"
                    @click="isMobileOpen = false"
                >
                    <TairoCollapseNavigationCollapseLinks
                        v-if="item.children"
                        :expanded="isOpen"
                        :item="item"
                        @clicked="isOpen = true"
                    />
                    <NuxtLink
                        v-else-if="item.to"
                        :class="!isOpen ? 'px-1 justify-center' : 'px-4'"
                        :to="item.to"
                        class="nui-focus text-white dark:text-muted-400/80 hover:bg-muted-100 dark:hover:bg-muted-700/60 hover:text-muted-600 dark:hover:text-muted-200 flex cursor-pointer items-center gap-4 rounded-lg py-3 transition-colors duration-300"
                        exact-active-class="!text-muted-600 bg-muted-100 dark:bg-muted-700/60  dark:text-white"
                    >
                        <Icon
                            :class="item.icon?.class"
                            :name="item.icon?.name"
                        />
                        <span
                            :class="!isOpen ? 'hidden' : 'block'"
                            class="whitespace-nowrap font-sans text-sm"
                        >
                            {{ item.name }}
                        </span>
                        <span
                            v-if="
                                item.subject === 'Task' && notificationCount > 0
                            "
                            class="relative flex h-3 w-3"
                        >
                            <span
                                class="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"
                            />
                            <span
                                class="relative inline-flex rounded-full h-3 w-3 bg-sky-500"
                            />
                        </span>
                    </NuxtLink>
                    <div
                        v-else-if="item.divider"
                        class="border-muted-200 dark:border-muted-700 my-3 h-px w-full border-t"
                    />
                    <button
                        v-else
                        :class="!isOpen ? 'px-1 justify-center' : 'px-4'"
                        class="nui-focus text-white dark:text-muted-400/80 hover:bg-muted-100 dark:hover:bg-muted-700/60 hover:text-muted-600 dark:hover:text-muted-200 flex w-full cursor-pointer items-center gap-4 rounded-lg py-3 transition-colors duration-300"
                        @click="item.click"
                    >
                        <Icon
                            :class="item.icon?.class"
                            :name="item.icon?.name"
                        />
                        <span
                            :class="!isOpen ? 'hidden' : 'block'"
                            class="whitespace-nowrap font-sans text-sm"
                        >
                            {{ item.name }}
                        </span>
                    </button>
                </li>
            </ul>
        </div>
        <!--Footer-->
        <slot name="footer" />
    </div>
</template>

<script lang="ts" setup>
import TairoCollapseNavigationCollapseLinks from "~/components/tairo/TairoCollapseNavigationCollapseLinks.vue";

const { isOpen, isMobileOpen, menuItems } = useCollapse();
const commonStore = useCommonStore();
const { notificationCount } = storeToRefs(commonStore);
const { $socket } = useNuxtApp();
const route = useRoute();

// on("connect") without a handler registered `undefined` as a listener, and
// socket.io threw "Cannot read properties of undefined (reading 'apply')"
// every time the socket (re)connected after this component was mounted.
function onNotification() {
    if (route.path !== "/tasks") {
        notificationCount.value++;
    }
}

onMounted(() => {
    ($socket as any)?.on("notification", onNotification);
});

onUnmounted(() => {
    ($socket as any)?.off("notification", onNotification);
});
</script>

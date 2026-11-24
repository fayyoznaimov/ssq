<template>
    <div class="group">
        <button
            ref="buttonRef"
            :class="[
                props.expanded ? 'gap-4 px-4' : 'px-2 justify-center',
                isActive ? 'text-white font-semibold dark:text-white' : 'text-muted-100 dark:text-muted-300',
            ]"
            class="nui-focus hover:bg-muted-100 dark:hover:bg-muted-700/60 hover:text-muted-700 dark:hover:text-white flex w-full cursor-pointer items-center rounded-lg py-3 transition-colors duration-300"
            :aria-expanded="isOpen"
            @click.stop.prevent="onDropClick"
        >
            <!-- the group of the open page is bold and white (text-primary-500 was the colour of the menu itself) -->
            <Icon
                :class="item.icon.class"
                :name="item.icon.name"
                class="shrink-0"
            />
            <span
                :class="!props.expanded ? 'hidden' : 'block'"
                class="block whitespace-nowrap font-sans text-sm"
            >
                {{ item.name }}
            </span>
            <span
                :class="!props.expanded ? 'hidden' : 'flex'"
                class="ms-auto items-center justify-center"
            >
                <Icon
                    :class="!isOpen ? 'rotate-180' : ''"
                    class="h-4 w-4 transition-transform duration-200"
                    name="lucide:chevron-up"
                />
            </span>
        </button>

        <ul
            v-if="props.expanded"
            :class="{
                'max-h-0 overflow-hidden opacity-0 group-focus-within:max-h-max group-focus-within:overflow-visible group-focus-within:opacity-100':
                    !isOpen,
                'after:border-muted-200 max-h-max opacity-100': isOpen,
            }"
            class="border-muted-200 relative block ps-4"
        >
            <li
                v-for="child in props.item.children"
                :key="child.to"
                class="border-muted-300 dark:border-muted-700 ms-2 border-s-2 first:mt-2"
            >
                <NuxtLink
                    :to="child.to"
                    :class="isCurrent(child.to)
                        ? '!border-primary-500 bg-muted-100 !text-muted-800 font-semibold dark:!border-primary-200 dark:bg-muted-700 dark:!text-white'
                        : 'text-muted-200 dark:text-muted-300'"
                    :aria-current="isCurrent(child.to) ? 'page' : undefined"
                    class="nui-focus hover:bg-muted-100 dark:hover:bg-muted-700/60 hover:text-muted-700 dark:hover:text-white relative -left-0.5 flex cursor-pointer items-center gap-2 border-s-2 border-transparent py-2 ps-4 transition-colors duration-300"
                >
                    <Icon
                        :class="child.icon.class"
                        :name="child.icon.name"
                        class="shrink-0"
                    />
                    <span
                        :class="[!props.expanded ? 'hidden' : 'block']"
                        class="whitespace-nowrap font-sans text-[0.85rem]"
                    >
                        {{ child.name }}
                    </span>
                </NuxtLink>
            </li>
        </ul>
    </div>
</template>

<script lang="ts" setup>
const props = defineProps<{
    item: any
    expanded?: boolean
}>();

const emit = defineEmits(['clicked']);

const route = useRoute();

const isActive = computed(() => {
    if (props.item?.activePath) {
        return route.path.startsWith(props.item.activePath);
    }
    // no activePath in app.config.ts (every group): the group of the open page by its links, so «Списки»
    // is open and lit on /lists/contacts/5
    return (props.item?.children ?? []).some((child: any) =>
        typeof child?.to === 'string' && child.to !== '/' && route.path.startsWith(child.to));
});

/** the link of the open page: the longest address of the group the page is under (/lists/companies/130 → «Компании») */
const currentChild = computed(() => {
    let best: string | null = null;
    for (const child of props.item?.children ?? []) {
        const to = child?.to;
        if (typeof to !== 'string') continue;
        if ((route.path === to || route.path.startsWith(to + '/')) && (!best || to.length > best.length)) best = to;
    }
    return best;
});

function isCurrent(to: string) {
    return currentChild.value === to;
}

const buttonRef = ref<HTMLElement>();
const isOpen = ref(isActive.value);
// going to a page of the group opens it
watch(isActive, (active) => {
    if (active) isOpen.value = true;
});

function onDropClick() {
    isOpen.value = !isOpen.value;
    if (!isOpen.value) {
        buttonRef.value?.blur();
    }
    emit('clicked');
}
</script>

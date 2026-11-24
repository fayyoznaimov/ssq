<template>
    <div :class="wrapperClass">
        <slot name="navigation">
            <TairoCollapseNavigation v-if="collapseEnabled" v-click-outside="closeModal"/>
        </slot>

        <div :class="mainClass">
            <div
                :class="[
                    props.condensed && !props.horizontalScroll && 'w-full',
                    !props.condensed && props.horizontalScroll && 'mx-auto w-full',
                    !props.condensed &&
                        !props.horizontalScroll &&
                        'w-full min-h-screen flex flex-col',
                ]"
            >
                <slot name="toolbar">
                    <TairoCollapseToolbar
                        v-if="toolbarEnabled"
                        :collapse="props.collapse"
                        :horizontal-scroll="props.horizontalScroll"
                    >
                        <template #title>
                            <!-- the name of the page, on a phone too; the crumbs only from md (no room on a phone) -->
                            <div class="min-w-0">
                                <span class="block truncate"><slot name="toolbar-title"></slot></span>
                                <BaseBreadcrumb class="breadCrumb hidden md:block" :items="breadcrumb">
                                    <Icon name="ph:arrow-right"></Icon>
                                </BaseBreadcrumb>
                            </div>
                        </template>
                    </TairoCollapseToolbar>
                </slot>
                <slot/>
            </div>
        </div>
    </div>
</template>


<script lang="ts" setup>
import TairoCollapseNavigation from '~/components/tairo/TairoCollapseNavigation.vue';
import TairoCollapseToolbar from '~/components/tairo/TairoCollapseToolbar.vue';


const props = withDefaults(
    defineProps<{
        collapse?: boolean
        toolbar?: boolean
        condensed?: boolean
        horizontalScroll?: boolean
        minHeight?: boolean
        wrapperPadding?: boolean
    }>(),
    {
        collapse: true,
        toolbar: true,
        minHeight: true,
        wrapperPadding: true,
    },
);

const app = useAppConfig();
const route = useRoute();
const router = useRouter();
const {isOpen, isMobileOpen} = useCollapse();

const collapseEnabled = computed(() => {
    return (app.tairo.collapse?.navigation?.enabled !== false && props.collapse);
});

const toolbarEnabled = computed(() => {
    return (app.tairo.collapse?.toolbar?.enabled !== false && props.toolbar);
});

const wrapperClass = computed(() => {
    const list = ['bg-muted-100 dark:bg-muted-900'];
    if (props.wrapperPadding) {
        list.push('pb-20');
    }

    return list;
});

const mainClass = computed(() => {
    if (props.condensed) {
        return 'bg-muted-100 dark:bg-muted-900 relative w-full overflow-x-hidden';
    }

    if (!collapseEnabled.value) {
        return 'bg-muted-100 dark:bg-muted-900 relative w-full overflow-x-hidden px-4 transition-all duration-300 xl:px-10';
    }

    const list = [
        'bg-muted-100 dark:bg-muted-900 relative w-full px-4 overflow-x-hidden transition-all duration-300',
    ];

    if (isOpen.value) {
        list.push('lg:max-w-[calc(100%_-_280px)] lg:ms-[280px]');
    } else {
        list.push('lg:max-w-[calc(100%_-_80px)] lg:ms-[80px]');
    }

    if (props.horizontalScroll) {
        list.push('!pe-0 xl:!pe-0');
    }

    if (props.minHeight) {
        list.push('min-h-screen');
    }

    return list;
});

function closeModal(e: any) {
    if (e.target.id === 'openMenu') {
        isMobileOpen.value = true;
        return;
    }
    isMobileOpen.value = false;
}

const breadcrumb = ref<{ label: any; to: string }[]>([]);
// a card names its record in the last crumb («Контакты → Иван Петров», not «Новый контакт»):
// useRecordTitle() in components/company/recordTitle.ts sets { path, label }
const crumbTitle = useState<{ path: string; label: string } | null>('crumbTitle', () => null);

watch(() => route.fullPath, breadCrumbs);
watch(crumbTitle, breadCrumbs, { deep: true });

onMounted(() => breadCrumbs());

function breadCrumbs() {
    const subRoutes = [];
    let last = [];
    const subPath = route.path.slice(1).split('/');
    for (const r of subPath) {
        if (r === '') {
            continue;
        }
        last.push(r);
        let p = last.join('/');
        const meta = router.resolve(`/${p}`).meta;
        const named = crumbTitle.value?.path === `/${p}` ? crumbTitle.value.label : null;
        subRoutes.push({
            // a page for a new and an existing record (/lists/companies/new) can name the new one itself
            label: named || (r === 'new' && meta.verboseNew ? meta.verboseNew : meta.verbose),
            to: `/${p}`,
        });
    }
    breadcrumb.value = [{to: '/', label: router.resolve('/').meta.verbose}, ...subRoutes];
}
</script>

<style lang="css">
    .breadCrumb ul {
        margin: 0 !important;
    }
</style>

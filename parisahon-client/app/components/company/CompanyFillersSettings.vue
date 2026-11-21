<template>
    <section class="max-w-sm flex flex-col gap-4">
        <div
            v-for="(filler, idx) in fillers.company"
            class="flex items-center gap-3"
        >
            <details
                :open="openFiller === idx"
                class="w-full"
            >
                <summary
                    v-show="openFiller !== idx"
                    @click="openFiller = idx"
                >
                    <BaseInput
                        v-model="filler.field"
                        type="text"
                        placeholder="пр.: "
                        icon="ph:textbox"
                        :classes="{ wrapper: 'w-full' }"
                        :form="'filler' + filler.id"
                        name="field"
                    />
                </summary>
                <BaseInput
                    ref="fieldRefs"
                    v-model="filler.field"
                    type="text"
                    placeholder="пр.: "
                    icon="ph:textbox"
                    :classes="{ wrapper: 'w-full' }"
                    :form="'filler' + filler.id"
                    name="field"
                />
                <BaseSwitchThin
                    v-model="filler.is_required"
                    :form="'filler' + filler.id"
                    name="required"
                    label="Обязательное поле"
                    :classes="{ wrapper: 'mt-4 max-w-fit' }"
                />
                <div class="flex gap-2 mt-4">
                    <form
                        :id="'filler' + filler.id"
                        @submit.prevent="onFillerSave"
                    >
                        <input
                            type="hidden"
                            name="action_id"
                            :value="`save${filler.id}`"
                        >
                        <input
                            type="hidden"
                            name="id"
                            :value="filler.id"
                        >
                        <input
                            type="hidden"
                            name="idx"
                            :value="idx"
                        >
                        <input
                            v-if="filler.id < 0"
                            type="hidden"
                            name="new"
                            value="new"
                        >
                        <BaseButton
                            size="sm"
                            type="submit"
                            :loading="
                                isLoadingMap[`save${filler.id}`]
                            "
                        >
                            Сохранить
                        </BaseButton>
                    </form>
                    <form @submit.prevent="onFillerDelete">
                        <input
                            v-if="filler.id < 0"
                            type="hidden"
                            name="new"
                            value="new"
                        >
                        <input
                            type="hidden"
                            name="action_id"
                            :value="`delete${filler.id}`"
                        >
                        <input
                            type="hidden"
                            name="id"
                            :value="filler.id"
                        >
                        <input
                            type="hidden"
                            name="idx"
                            :value="idx"
                        >
                        <BaseButton
                            color="danger"
                            size="sm"
                            type="submit"
                            :loading="
                                isLoadingMap[
                                    `delete${filler.id}`
                                ]
                            "
                        >
                            Удалить
                        </BaseButton>
                    </form>
                </div>
            </details>
        </div>
        <BaseButton
            variant="pastel"
            class="w-full"
            @click="addFiller"
        >
            <Icon
                class="size-4 mr-2"
                name="ph:plus"
            />
            Добавить поле
        </BaseButton>
    </section>
</template>

<script lang="ts" setup>
import { useAsync } from "~/composables/useAsync";
import type { Filler } from "~/types/filler";

// The custom fields of companies (the "Настройка" tab of the company card, admin only)

// Fillers store
const fillersStore = useFillersStore();
const { fillers } = storeToRefs(fillersStore);

let fakeId = -1;
const toast = useToast("GlobalToast");
const fillersService = useService("fillers", { auth: true });

const openFiller = ref();
const fieldRefs = ref();

const { runWithId, isLoadingMap } = useAsync();

function addFiller() {
    if (!fillers.value.company) fillers.value.company = [];
    fillers.value.company.push({
        id: --fakeId,
        field: "",
        target: "company",
        created_at: new Date().toISOString(),
        is_required: false,
    });
}

async function onFillerSave(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const isNew = formData.get("new");
    const field = formData.get("field");
    const isRequired = formData.get("required") === "on";
    const idx = Number(formData.get("idx") as string);
    const id = Number(formData.get("id") as string);
    const actionId = formData.get("action_id") as string;

    if (isNew) {
        const result = await promiseResult(
            runWithId(
                fillersService
                    .create({
                        field,
                        target: "company",
                        is_required: isRequired,
                    })
                    .exec(),
                actionId
            )
        );
        if (!result.ok)
            return toast.show({
                message: result.error.message,
                type: "error",
                timeout: 3000,
            });
        fillers.value.company.splice(idx, 1, result.value as Filler);
        return;
    }

    const result = await promiseResult(
        runWithId(
            fillersService
                .patch(id, {
                    field,
                    target: "company",
                    is_required: isRequired,
                })
                .exec(),
            actionId
        )
    );
    if (!result.ok)
        toast.show({
            message: result.error.message,
            type: "error",
            timeout: 3000,
        });
}

async function onFillerDelete(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const isNew = formData.get("new");
    const actionId = formData.get("action_id") as string;
    const id = Number(formData.get("id") as string);
    if (isNew) {
        fillers.value.company = fillers.value.company.filter(
            (f) => f.id !== id
        );
        return;
    }

    const result = await promiseResult(
        runWithId(fillersService.remove(id).exec(), actionId)
    );
    if (!result.ok)
        return toast.show({
            message: result.error.message,
            type: "error",
            timeout: 3000,
        });
    fillers.value.company = fillers.value.company.filter((f) => f.id !== id);
}

watch(openFiller, () => {
    nextTick(() => {
        fieldRefs.value[openFiller.value].el?.focus();
    });
});
</script>

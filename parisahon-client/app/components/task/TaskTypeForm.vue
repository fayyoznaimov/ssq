<template>
    <div>
        <div
            v-click-outside="closeInput"
            class="flex justify-between items-end pt-1"
        >
            <div>
                <h6
                    v-if="!isAddNewType"
                    class="text-left text-muted-800 text-sm dark:text-white"
                    @click="openInput"
                >
                    Добавить сделку
                </h6>
                <BaseInput
                    label="Новый тип"
                    v-else
                    v-model="name"
                    autofocus
                    class="w-full"
                    placeholder="Добавить тип"
                />
            </div>
            <button class="mb-2 border-muted-200 mr-4 dark:border-muted-700 border rounded-lg p-1 flex text-white items-center justify-center !bg-primary-400 duration-200">
                <Icon
                    v-if="isAddNewType"
                    name="ph:check"
                    @click="save"
                />
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import BaseInput from '~/components/form/BaseInput.vue';

const props = defineProps<{ newType: string; toggle: boolean }>();
const emit = defineEmits(['save']);
const name = ref(props.newType);
const isAddNewType = ref(props.toggle);

function closeInput() {
    isAddNewType.value = false;
}

function openInput() {
    isAddNewType.value = true;
}

function save() {
    emit('save', {
        name: name.value,
        id: 'new'
    });
    closeInput();
}
</script>

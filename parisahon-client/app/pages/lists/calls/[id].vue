<template>
    <div>
        <header class="mb-5">
            <h1 class="text-xl">
                Записи звонков {{ user.username }}
            </h1>
            <h2 class="text-sm text-gray-500">
                Список записей звонков
            </h2>
        </header>

        <main>
            <Transition
                name="fade"
                mode="out-in"
            >
                <ul
                    v-if="loading"
                >
                    <li>
                        <BasePlaceload
                            class="h-5 w-[200px] rounded mb-4"
                        /> 
                        <BasePlaceload
                            class="h-16 rounded"
                        /> 
                    </li>
                </ul>

                <ul
                    v-else-if="recordings.length > 0"
                    class="flex flex-col gap-3 mt-2"
                >
                    <li
                        v-for="(recording, key) in recordings"
                        :key="key"
                        class="p-2"
                    >
                        <p class="text-sm text-gray-500 mb-3 flex items-center justify-between">
                            <span>
                                Номер телефона: {{ recording.from_number }}
                            </span>
                            <time>
                                {{ formatDate(recording.created_at, "DD.MM.YYYY, HH:mm") }}
                            </time>
                        </p>
                        <AudioPlayer :src="recording.path" />
                    </li>
                </ul>

                <!-- No Data For Files -->
                <BasePlaceholderPage
                    v-else
                    title="Нет записей"
                    subtitle="Для данного пользователя пока не загружено записей."
                />
            </Transition>
        </main>
    </div>
</template>

<script lang="ts" setup>
import AudioPlayer from "~/components/common/AudioPlayer.vue";
import { type User,UserRole } from "~/types/user";

interface Call {
    path: string
    from_number: string
}

const route = useRoute();

const userService = useService("users", { auth: true });

const { data: user, run: runUser, isLoading: userLoading } = useAsync<User>({ role: UserRole.Agent });

const fetchUser = async () => {
    await runUser(userService.get(route.params.id as string).exec());
};

fetchUser();

const { data: recordings, run: runRecordings, isLoading: recordingsLoading } = useAsync<Call[]>([]);

const fetchRecordings = async () => {
    await runRecordings(userService.getNested(route.params.id as string, "recordings").exec());
};

fetchRecordings();

const loading = computed(() => userLoading.value || recordingsLoading.value);

useHead({
    title: "Звонки"
});

definePageMeta({
    authRoute: true,
    layout: "account",
    verbose: "Звонки"
});
</script>
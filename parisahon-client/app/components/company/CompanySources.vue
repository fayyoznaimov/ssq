<template>
    <section v-if="list === 'files'">
        <ul class="flex flex-col gap-5">
            <li
                v-for="user in company.users"
                :key="user.id"
                class="text-muted-900 dark:text-white mb-2"
            >
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <BaseAvatar
                            :text="user.username.slice(0, 2)"
                            size="xs"
                            class="bg-primary-400 text-white dark:bg-primary-300"
                        />
                        <span>{{ user?.username }}</span>
                    </div>
                    <BaseButtonIcon
                        v-if="!sources[user.id]"
                        rounded="md"
                        color="muted"
                        :loading="sourcesLoading[user.id]"
                        @click="fetchSource(user.id)"
                    >
                        <Icon
                            name="ph:cloud-arrow-down"
                            size="24"
                        />
                    </BaseButtonIcon>
                </div>
                <ul
                    v-if="sources[user.id]?.files?.length"
                    class="flex flex-col gap-3 mt-2"
                >
                    <li
                        v-for="(file, key) in sources[user.id]
                            ?.files"
                        :key
                        class="flex items-center space-x-2 p-2"
                    >
                        <Icon
                            :name="getFileIcon(file.name || file.path)"
                            class="bg-muted-200 dark:bg-muted-700 text-muted-600 dark:text-muted-200 p-1.5 size-10 rounded-md shrink-0"
                        />
                        <div
                            class="flex flex-col text-sm flex-1 min-w-0"
                        >
                            <p
                                class="text-muted-900 dark:text-white underline underline-offset-2 cursor-pointer break-words"
                                @click="download(file)"
                            >
                                {{ file.name || file.path }}
                            </p>
                        </div>
                    </li>
                </ul>
                <div
                    v-else-if="sources[user.id]?.files"
                    class="mt-2 pl-3"
                >
                    У агента нет файлов.
                </div>
            </li>

            <!-- No Data For Files -->
            <BasePlaceholderPage
                v-if="!hasSources"
                title="Нет файлов"
                subtitle="Для данной компании пока не загружено файлов."
            />
        </ul>
    </section>
    <section v-else-if="list === 'recordings'">
        <ul class="flex flex-col gap-5">
            <li
                v-for="user in company.users"
                :key="user.id"
                class="text-muted-900 dark:text-white mb-2"
            >
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <BaseAvatar
                            :text="user.username.slice(0, 2)"
                            size="xs"
                            class="bg-primary-400 text-white dark:bg-primary-300"
                        />
                        <span>{{ user?.username }}</span>
                    </div>
                    <BaseButtonIcon
                        v-if="!sources[user.id]"
                        rounded="md"
                        color="muted"
                        :loading="sourcesLoading[user.id]"
                        @click="fetchSource(user.id)"
                    >
                        <Icon
                            name="ph:cloud-arrow-down"
                            size="24"
                        />
                    </BaseButtonIcon>
                </div>
                <ul
                    v-if="sources[user.id]?.recordings?.length"
                    class="flex flex-col gap-3 mt-2"
                >
                    <li
                        v-for="(recording, key) in sources[
                            user.id
                        ]?.recordings"
                        :key
                        class="flex items-center space-x-2 p-2"
                    >
                        <AudioPlayer :src="recording.path" />
                    </li>
                </ul>
                <div
                    v-else-if="sources[user.id]?.recordings"
                    class="mt-2 pl-3"
                >
                    У агента нет записей.
                </div>
            </li>

            <!-- No Data For Files -->
            <BasePlaceholderPage
                v-if="!hasSources"
                title="Нет записей"
                subtitle="Для данной компании пока не загружено записей."
            />
        </ul>
    </section>
</template>

<script lang="ts" setup>
import AudioPlayer from "~/components/common/AudioPlayer.vue";
import { useAgentSourceController } from "~/composables/company/useAgentSourceController";
import type { Company } from "~/types/user";
import { downloadFile, getFileIcon, uploadUrl } from "~/utils/files";

// The files and the call recordings of the company's contacts ("Файлы" and "Звонки" tabs).
// One instance serves both tabs and lives as long as the page: the sources loaded for a
// contact stay when the tab changes, and the first contact's ones load with the company.
const props = defineProps<{
    /** The active tab: "files" shows the files, "recordings" the call recordings, any other nothing. */
    list: string;
    company: Company;
    companyLoading: boolean;
}>();
const { company, companyLoading } = toRefs(props);

const { sources, hasSources, sourcesLoading, fetchSource } = useAgentSourceController(
    companyLoading,
    company
);

const toast = useToast("GlobalToast");

// the name on disk is random: save the file under its own name
async function download(file: { path: string; name?: string }) {
    try {
        await downloadFile(uploadUrl(file.path), file.name);
    } catch (error) {
        toast.show({ message: (error as Error).message, type: "error", timeout: 3000 });
    }
}
</script>

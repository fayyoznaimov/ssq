import type { CtrAgentSource } from "~/types/ctrAgent";
import type { Company, CompanyUser } from "~/types/user";

export const useAgentSourceController = (
    companyLoading: Ref<boolean>,
    company: Ref<Company>
) => {
    const route = useRoute();

    const getSourceService = (agentId: number) => {
        return useService(
            `/companies/${route.params.id}/agent/${agentId}/source/`,
            { auth: true }
        );
    };

    const sources = reactive<Record<number, CtrAgentSource>>({});
    const sourcesLoading = reactive<Record<number, boolean>>({});

    const hasSources = computed(() => Object.keys(sources).length > 0);

    const fetchSource = async (agentId: number) => {
        const service = getSourceService(agentId);

        try {
            sourcesLoading[agentId] = true;
            sources[agentId] = await service.find<CtrAgentSource>().exec();
        } catch (error) {
            console.error(error);
        }
    };

    watch(companyLoading, async (newValue) => {
        if (newValue) {
            return;
        }

        const hasAgents = company.value.users?.length > 0;

        if (!hasAgents) {
            return;
        }

        company.value.users.forEach((agent: CompanyUser) => {
            sourcesLoading[agent.id] = false;
        });

        await fetchSource(company.value.users[0].id);
    });

    return { sources, hasSources, sourcesLoading, fetchSource };
};

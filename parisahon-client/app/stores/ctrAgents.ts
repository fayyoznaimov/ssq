import type { CtrAgent } from "~/types/ctrAgent";
import { UserRole } from "~/types/user";
import {
    type Schema,
} from "~/utils/validation";

export const useCtrAgentsStore = defineStore("ctrAgents", () => {
    const fillersStore = useFillersStore();
    const { fillers } = storeToRefs(fillersStore);
    const ctrAgents = ref<CtrAgent[]>([]);
    // id of the primary contact (its phone / email stand in for the company's); null = the only one
    const primaryContactId = ref<number | null>(null);

    /**
     * Validation schema for CtrAgent
     */
    const ctrAgentsShema = reactive<Schema<string>>({});

    /**
     * Creates default fillers configuration for a new user
     */
    const getDefaultFillersForUser = () => {
        return fillers.value.user.map((filler) => ({
            ...filler,
            value: undefined,
        }));
    };

    /**
     * Returns a new CtrAgent object with default values
     */
    const getCtrAgent = (): CtrAgent => ({
        tempId: generateId(),
        username: undefined,
        email: undefined,
        phone: undefined,
        role: UserRole.CtrAgent,
        fillers: getDefaultFillersForUser(),
    });

    /**
     * Applies validation schema for a CTR agent
     */
    const applySchema = (agent: CtrAgent) => {
        // Apply schema for user fields
        ctrAgentsShema[`ctr-agent-${agent.tempId}-username`] = [required("Обязательное поле")];
        ctrAgentsShema[`ctr-agent-${agent.tempId}-email`] = [validEmail("Неверный email")];
        ctrAgentsShema[`ctr-agent-${agent.tempId}-phone`] = [required("Обязательное поле"), validPhone("Неверный номер телефона")];

        // Apply fillers schema
        agent.fillers.forEach((filler) => {
            if (filler.is_required) {
                ctrAgentsShema[`ctr-agent-${agent.tempId}-fillers-${filler.id}`] = [required("Обязательное поле")];
            }
        });
    };

    /**
     * Adds a new CTR agent with default values to the store
     */
    const addCtrAgent = () => {
        const ctrAgent = getCtrAgent();
        ctrAgents.value.push(ctrAgent);

        // Apply schema
        applySchema(ctrAgent);
    };

    /**
     * Removes validation schema for a CTR agent
     */
    const removeCtrAgentSchema = (agent: CtrAgent) => {
        // Remove user schema
        delete ctrAgentsShema[`ctr-agent-${agent.tempId}-username`];
        delete ctrAgentsShema[`ctr-agent-${agent.tempId}-email`];
        delete ctrAgentsShema[`ctr-agent-${agent.tempId}-phone`];

        // Remove fillers schema
        agent.fillers.forEach((filler) => {
            delete ctrAgentsShema[`ctr-agent-${agent.tempId}-fillers-${filler.id}`];
        });
    };

    /**
     * Removes a CTR agent by ID
     */
    const removeCtrAgent = (agent: CtrAgent) => {
        if (!agent.id && !agent.tempId) return;

        const idx = ctrAgents.value.findIndex(
            (user) =>
                (user.id && user.id === agent.id) ||
                (user.tempId && user.tempId === agent.tempId)
        );

        if (idx !== -1) {
            if (agent.id && primaryContactId.value === agent.id) primaryContactId.value = null;
            ctrAgents.value.splice(idx, 1);

            // Remove schema
            removeCtrAgentSchema(agent);
        }
    };

    /**
     * Transforms CTR agents data for API submission
     * Filters out agents without usernames and includes only fillers with values
     */
    const getCtrAgentsDTO = () => {
        return ctrAgents.value
            .filter((user) => user.username)
            .map((user) => {
                const validFillers = user.fillers
                    .filter((filler) => filler.value)
                    .map((filler) => ({
                        id: filler.id,
                        filler_id: filler.id,
                        value: filler.value,
                    }));

                return {
                    ...user,
                    fillers: validFillers,
                };
            });
    };

    /**
     * Applies company CTR agents data from API to the store
     * Maps existing fillers with values from provided data
     */
    const applyCtrAgents = (companyCtrAgents: CtrAgent[]) => {
        const updatedAgents = companyCtrAgents.map((user) => ({
            ...user,
            role: UserRole.CtrAgent,
            fillers: fillers.value.user.map((filler) => ({
                ...filler,
                value: user.fillers.find((f) => f.id === filler.id)?.value,
            })),
        }));

        ctrAgents.value = updatedAgents;
    };

    const $reset = () => {
        ctrAgents.value = [];
        primaryContactId.value = null;
    };

    return {
        ctrAgents,
        primaryContactId,
        addCtrAgent,
        getDefaultFillersForUser,
        removeCtrAgent,
        getCtrAgentsDTO,
        applyCtrAgents,
        $reset,
    };
});

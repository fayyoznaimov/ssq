import type { CtrAgent } from "~/types/ctrAgent";
import { UserRole } from "~/types/user";
import { phoneOrLocal } from "~/components/company/phone";
import {
    type Schema,
} from "~/utils/validation";

export const useCtrAgentsStore = defineStore("ctrAgents", () => {
    const fillersStore = useFillersStore();
    const { fillers } = storeToRefs(fillersStore);
    const ctrAgents = ref<CtrAgent[]>([]);
    // id of the primary contact (its phone / email stand in for the company's); null = the only one
    const primaryContactId = ref<number | null>(null);
    // saved contacts taken off with the trash button: detached from the company on save
    // (PATCH /companies/:id removed_user_ids; before, they came back after a reload)
    const removedIds = ref<number[]>([]);

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
            value_id: undefined,
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
        // Apply schema for user fields; a contact may have no e-mail and no phone (Telegram, a business card)
        ctrAgentsShema[`ctr-agent-${agent.tempId}-username`] = [required("Обязательное поле")];
        ctrAgentsShema[`ctr-agent-${agent.tempId}-email`] = [optional(validEmail("Неверный email"))];
        ctrAgentsShema[`ctr-agent-${agent.tempId}-phone`] = [optional(phoneOrLocal("Неверный номер телефона"))];

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
     * Removes a CTR agent by ID. A saved one is detached from the company when the company is saved
     * (it stays in the CRM, with its deals and history).
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
            if (agent.id && !removedIds.value.includes(agent.id)) removedIds.value.push(agent.id);
            ctrAgents.value.splice(idx, 1);

            // Remove schema
            removeCtrAgentSchema(agent);
        }
    };

    /**
     * Transforms CTR agents data for API submission (PATCH / POST /companies `users`).
     * A saved contact is always sent; a new form only when it has a name. Custom fields go by the field
     * ({filler_id, value}: set, or cleared when the value was removed): they were sent with the id of
     * the field definition as the id of a value and changed other people's values.
     */
    const getCtrAgentsDTO = () => {
        return ctrAgents.value
            .filter((user) => user.id || user.username?.trim())
            .map((user) => {
                const validFillers = user.fillers
                    .filter((filler) => String(filler.value ?? "").trim() || filler.value_id)
                    .map((filler) => ({
                        filler_id: filler.id,
                        value: String(filler.value ?? "").trim(),
                    }));

                return {
                    ...(user.id ? { id: user.id } : {}),
                    username: user.username?.trim(),
                    email: user.email?.trim() || null,
                    phone: user.phone?.trim() || null,
                    role: UserRole.CtrAgent,
                    fillers: validFillers,
                };
            });
    };

    /**
     * Applies company CTR agents data from API to the store
     * Maps every contact field to the contact's value of it (GET /companies/:id gives the values as
     * { id: the id of the value, filler_id, value })
     */
    const applyCtrAgents = (companyCtrAgents: CtrAgent[]) => {
        const updatedAgents = (companyCtrAgents ?? []).map((user: any) => ({
            ...user,
            role: UserRole.CtrAgent,
            fillers: fillers.value.user.map((filler) => {
                const saved = (user.fillers ?? []).find((f: any) => f.filler_id === filler.id);
                return {
                    ...filler,
                    value: saved?.value,
                    value_id: saved?.id,
                };
            }),
        }));

        ctrAgents.value = updatedAgents;
        removedIds.value = [];
    };

    const $reset = () => {
        ctrAgents.value = [];
        primaryContactId.value = null;
        removedIds.value = [];
    };

    return {
        ctrAgents,
        primaryContactId,
        removedIds,
        addCtrAgent,
        getDefaultFillersForUser,
        removeCtrAgent,
        getCtrAgentsDTO,
        applyCtrAgents,
        $reset,
    };
});

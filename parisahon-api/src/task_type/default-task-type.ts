import { EntityManager } from 'typeorm';
import { TaskType } from './task_type.entity';

/**
 * The type of the tasks the CRM makes by itself (rules of the autopilot, triggers without a type):
 * DEFAULT_TASK_TYPE ("Связаться"), else the first type, else that type is created. A task without a
 * type breaks the task board and the history of the deal in the web client.
 */
export async function defaultTaskType(manager: EntityManager): Promise<TaskType> {
  const repo = manager.getRepository(TaskType);
  const name = (process.env.DEFAULT_TASK_TYPE || 'Связаться').trim();
  const named = await repo.findOne({ where: { name } });
  if (named) return named;
  const first = (await repo.find({ order: { id: 'ASC' }, take: 1 }))[0];
  if (first) return first;
  return repo.save(repo.create({ name }));
}

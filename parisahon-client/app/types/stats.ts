import type { FileSource } from "./stage";

export type TaskStats = {
  tasks_overdue: string;
  tasks_closed: string;
  active_tasks: string;
  deals_without_tasks: string;
  outgoing_calls: string;
  incoming_calls: string;
  succesfull_deals: string;
}

export type TotalManagerStats = {
  total_budget: string;
  deal_count: string;
}

export type FileStat = {
  id: number;
  name: string;
  path: string;
  size: string;
  from: FileSource;
  extension: string | null;
  created_at: string;
  uploaded_by: {
    id: number;
    username: string;
  }
}

export type DesktopStats = {
  task_stats: TaskStats;
  total_manager_stats: TotalManagerStats;
  file_stats: FileStat[];
}

type Objective = {
    yearly: number;
    monthly: number;
    quarterly: number;
}

type UserObjective = {
    id: number;
    username: string;
    objectives: Objective;
}

export type ObjectiveStat = {
  id: number;
  name: string;
  objectives: Objective;
  users: UserObjective[];
}

export type ObjectiveResultStat = {
  id: number;
  name: string;
  objectives: Objective | null;
  total_budget: number;
  users: (UserObjective & {total_budget: number})[];
}

// GET /analytics/deals (AnalyticsService.dealAnalytics): the deals by the stage they are in now
export type DealStats = {
  average_deal_duration_in_minutes: number | string | null;
  total_deal_count: number | string;
  total_deal_budget?: number;
  closed_deal_count?: number;
  stages: {
    id: number;
    name: string;
    color: string;
    order: number;
    description: string;
    deal_count: number;
    average_time_in_stage: number | null;
    stage_time_count?: number;
    total_deal_budget: number;
  }[];
}

export type UserStat = {
  id: number;
  username: string;
  deal_count: string;
  deal_budget: string;
  task_count: string;
}

export type CallStat = {
  user_name: string;
  avg_duration: string;
  call_count: string;
  outgoing_call_count: string;
  incoming_call_count: string;
  total_outgoing_duration: string;
  total_incoming_duration: string;
  total_call_duration: string;
  // the same durations in seconds (GET /analytics/calls)
  avg_duration_sec?: number;
  total_outgoing_sec?: number;
  total_incoming_sec?: number;
  total_call_sec?: number;
}

export type ConsolidatedStats = {
  graph: {
    date_start: string;
    date_end: string;
    new_count: number;
    won_count: number;
    lost_count: number;
  }[];
  deals: {
    total_stats: {
      total_deal_count: number;
      total_deal_budget: number;
      won_deal_count: number;
      won_deal_budget: number;
      lost_deal_count: number;
      lost_deal_budget: number;
    };
    stage_stats: {
      id: number;
      name: string;
      deal_count_in_stage: string;
      total_budget_in_stage: string;
    }[];
    user_stats: {
      id: number;
      username: string;
      deal_count: string;
      deal_budget: string;
    }[];
  };
  contacts: {
    total_stats: {
      total_ctr_agent_count: number;
      total_company_count: number;
    };
    user_stats: {
      id: number;
      username: string;
      ctr_agent_count: string;
      company_count: string;
    }[];
  };
  tasks: {
    total_stats: {
      count: number;
    };
    user_stats: {
      id: number;
      username: string;
      task_count: string;
    }[];
    type_stats: {
      id: number;
      name: string;
      task_count: string;
    }[];
  }
}
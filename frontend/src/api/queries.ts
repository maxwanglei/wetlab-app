import { keepPreviousData, QueryClient, queryOptions } from "@tanstack/react-query";
import { api, ApiError, parseDepletion, unwrap, type Schemas } from "./client";

const path = (experimentId: number) => ({ params: { path: { experiment_id: experimentId } } });

export const queries = {
  me: () =>
    queryOptions({ queryKey: ["me"], queryFn: () => unwrap(api.GET("/api/me")), staleTime: 5 * 60_000 }),
  health: () =>
    queryOptions({ queryKey: ["health"], queryFn: () => unwrap(api.GET("/api/health")), staleTime: 5 * 60_000 }),
  dashboard: () => queryOptions({ queryKey: ["dashboard"], queryFn: () => unwrap(api.GET("/api/dashboard")) }),
  experiments: () =>
    queryOptions({ queryKey: ["experiments"], queryFn: () => unwrap(api.GET("/api/experiments")) }),
  experiment: (experimentId: number) =>
    queryOptions({
      queryKey: ["experiments", experimentId],
      queryFn: () => unwrap(api.GET("/api/experiments/{experiment_id}", path(experimentId))),
    }),
  /** A single endpoint's rows are one analyte's: a metabolite's by its name, else the parent's. */
  measurements: (experimentId: number, metabolite: string | null = null) =>
    queryOptions({
      queryKey: ["experiments", experimentId, "measurements", metabolite],
      queryFn: () =>
        unwrap(
          api.GET("/api/experiments/{experiment_id}/measurements", {
            params: { path: { experiment_id: experimentId }, query: metabolite === null ? {} : { metabolite } },
          }),
        ),
    }),
  depletion: (experimentId: number) =>
    queryOptions({
      queryKey: ["experiments", experimentId, "depletion"],
      queryFn: () => unwrap(api.GET("/api/experiments/{experiment_id}/depletion", path(experimentId))).then(parseDepletion),
    }),
  depletionPreview: (experimentId: number, excludedIds: readonly number[], enabled: boolean) => {
    const queryKey = ["experiments", experimentId, "depletion", "preview", excludedIds] as const;
    return queryOptions<Schemas["DepletionResult"], Error, Schemas["DepletionResult"], typeof queryKey>({
      queryKey,
      enabled,
      staleTime: 0,
      queryFn: ({ signal }) =>
        unwrap(
          api.POST("/api/experiments/{experiment_id}/depletion/preview", {
            ...path(experimentId),
            body: { excluded_ids: [...excludedIds] },
            signal,
          }),
        ).then(parseDepletion),
      placeholderData: keepPreviousData,
    });
  },
  reagentLots: () =>
    queryOptions({
      queryKey: ["inventory", "reagent-lots"],
      queryFn: () => unwrap(api.GET("/api/inventory/reagent-lots")),
    }),
  tissueLots: () =>
    queryOptions({
      queryKey: ["inventory", "tissue-lots"],
      queryFn: () => unwrap(api.GET("/api/inventory/tissue-lots")),
    }),
  tissueLot: (lotId: number) =>
    queryOptions({
      queryKey: ["inventory", "tissue-lots", lotId],
      queryFn: () => unwrap(api.GET("/api/inventory/tissue-lots/{lot_id}", { params: { path: { lot_id: lotId } } })),
    }),
  /** Everything the forms offer as choices: compounds, enzymes, members, protocols, reagents and lots. */
  reference: () => queryOptions({ queryKey: ["reference"], queryFn: () => unwrap(api.GET("/api/reference")) }),
  /** A design as the request that would write it again, for the edit form. */
  design: (experimentId: number) =>
    queryOptions({
      queryKey: ["experiments", experimentId, "design"],
      queryFn: () => unwrap(api.GET("/api/experiments/{experiment_id}/design", path(experimentId))),
      staleTime: 0,
    }),
  /** Everyone in the lab, for admins. */
  members: () => queryOptions({ queryKey: ["members"], queryFn: () => unwrap(api.GET("/api/members")) }),
};

export const mutations = {
  login: (body: Schemas["LoginIn"]) => unwrap(api.POST("/api/auth/login", { body })),
  logout: async () => {
    const { error, response } = await api.POST("/api/auth/logout");
    if (!response.ok) throw new ApiError(response.status, typeof error === "string" ? error : "Could not end your session. Try signing out again.");
  },
  changePassword: (body: Schemas["PasswordChange"]) => unwrap(api.POST("/api/auth/password", { body })),
  addMember: (body: Schemas["MemberIn"]) => unwrap(api.POST("/api/members", { body })),
  updateMember: (memberId: number, body: Schemas["MemberUpdate"]) =>
    unwrap(api.PATCH("/api/members/{member_id}", { params: { path: { member_id: memberId } }, body })),
  setMemberPassword: (memberId: number, body: Schemas["PasswordSet"]) =>
    unwrap(api.POST("/api/members/{member_id}/password", { params: { path: { member_id: memberId } }, body })),
  createReagentLot: (body: Schemas["ReagentLotIn"]) => unwrap(api.POST("/api/inventory/reagent-lots", { body })),
  createTissueLot: (body: Schemas["TissueLotIn"]) => unwrap(api.POST("/api/inventory/tissue-lots", { body })),
  updateTissueLot: (lotId: number, body: Schemas["TissueLotUpdate"]) =>
    unwrap(api.PATCH("/api/inventory/tissue-lots/{lot_id}", { params: { path: { lot_id: lotId } }, body })),
  updateReagentLot: (lotId: number, body: Schemas["ReagentLotUpdate"]) =>
    unwrap(api.PATCH("/api/inventory/reagent-lots/{lot_id}", { params: { path: { lot_id: lotId } }, body })),
  createExperiment: (body: Schemas["ExperimentIn"]) => unwrap(api.POST("/api/experiments", { body })),
  replaceDesign: (experimentId: number, body: Schemas["ExperimentIn"]) =>
    unwrap(api.PUT("/api/experiments/{experiment_id}/design", { ...path(experimentId), body })),
  updateDetails: (experimentId: number, body: Schemas["ExperimentDetailsUpdate"]) =>
    unwrap(api.PATCH("/api/experiments/{experiment_id}", { ...path(experimentId), body })),
  pastePreview: (experimentId: number, body: Schemas["PastePreviewRequest"]) =>
    unwrap(api.POST("/api/experiments/{experiment_id}/measurements/paste-preview", { ...path(experimentId), body })),
  replaceMeasurements: (experimentId: number, body: Schemas["ReplaceMeasurements"]) =>
    unwrap(api.PUT("/api/experiments/{experiment_id}/measurements", { ...path(experimentId), body })),
  updatePreparedSolution: (solutionId: number, body: Schemas["PreparedSolutionUpdate"]) =>
    unwrap(api.PATCH("/api/inventory/prepared-solutions/{solution_id}", { params: { path: { solution_id: solutionId } }, body })),
  changeStatus: (experimentId: number, body: Schemas["StatusChange"]) =>
    unwrap(api.POST("/api/experiments/{experiment_id}/status", { ...path(experimentId), body })),
  saveDepletion: (experimentId: number, body: Schemas["SaveRequest"]) =>
    unwrap(api.POST("/api/experiments/{experiment_id}/depletion/save", { ...path(experimentId), body })).then(parseDepletion),
};

/** Lists and summaries that show an experiment's measurement count or saved-results flag. */
export function invalidateExperimentSummaries(queryClient: QueryClient, experimentId: number) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["experiments"], exact: true }),
    queryClient.invalidateQueries({ queryKey: ["experiments", experimentId], exact: true }),
    queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    queryClient.invalidateQueries({ queryKey: ["inventory", "tissue-lots"] }),
  ]);
}

/** A lot shows up in the inventory list, the dashboard's alerts, the forms' choices and, through its
 * expiry, in the lot references of any experiment that used it. Refetches even the lists not on
 * screen, so the page navigated to next already has the new row. */
export function invalidateLots(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["inventory", "reagent-lots"], refetchType: "all" }),
    queryClient.invalidateQueries({ queryKey: ["inventory", "tissue-lots"], refetchType: "all" }),
    queryClient.invalidateQueries({ queryKey: ["reference"] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    queryClient.invalidateQueries({ queryKey: ["experiments"] }),
  ]);
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: (failureCount, error) =>
          !(error instanceof ApiError && error.status < 500) && failureCount < 2,
      },
    },
  });
}

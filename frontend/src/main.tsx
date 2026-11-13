import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { createQueryClient } from "@/api/queries";
import { AppShell, NotFound, RouteError } from "@/components/AppShell";
import { AccountPage } from "@/pages/AccountPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { ExperimentsPage } from "@/pages/ExperimentsPage";
import { EditExperimentPage } from "@/pages/experiment/EditExperimentPage";
import { ExperimentPage } from "@/pages/experiment/ExperimentPage";
import { InventoryPage } from "@/pages/inventory/InventoryPage";
import { EditReagentLotPage, NewReagentLotPage } from "@/pages/inventory/ReagentLotForm";
import { EditTissueLotPage, NewTissueLotPage } from "@/pages/inventory/TissueLotForm";
import { TissueLotPage } from "@/pages/inventory/TissueLotPage";
import { LoginPage } from "@/pages/LoginPage";
import { NewExperimentPage } from "@/pages/new-experiment/NewExperimentPage";
import { PeoplePage } from "@/pages/PeoplePage";
import "./index.css";

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <AppShell />,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: "experiments", element: <ExperimentsPage /> },
          { path: "experiments/new", element: <NewExperimentPage /> },
          { path: "experiments/:experimentId/edit", element: <EditExperimentPage /> },
          { path: "experiments/:experimentId/:tab?", element: <ExperimentPage /> },
          { path: "inventory", element: <Navigate to="/inventory/reagents" replace /> },
          { path: "inventory/tissue-lots/new", element: <NewTissueLotPage /> },
          { path: "inventory/tissue-lots/:lotId/edit", element: <EditTissueLotPage /> },
          { path: "inventory/tissue-lots/:lotId", element: <TissueLotPage /> },
          { path: "inventory/reagent-lots/new", element: <NewReagentLotPage /> },
          { path: "inventory/reagent-lots/:lotId/edit", element: <EditReagentLotPage /> },
          { path: "inventory/:tab", element: <InventoryPage /> },
          { path: "account", element: <AccountPage /> },
          { path: "people", element: <PeoplePage /> },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
]);

const queryClient = createQueryClient();
const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

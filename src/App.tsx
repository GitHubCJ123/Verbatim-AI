import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import Home from "./routes/Home";
import Modes from "./routes/Modes";
import ModeEditor from "./routes/ModeEditor";
import Apps from "./routes/Apps";
import Vocabulary from "./routes/Vocabulary";
import History from "./routes/History";
import Settings from "./routes/Settings";
import Account from "./routes/Account";

const router = createMemoryRouter(
  [
    {
      path: "/",
      element: <AppShell />,
      children: [
        { index: true, element: <Home /> },
        { path: "modes", element: <Modes /> },
        { path: "modes/editor", element: <ModeEditor /> },
        { path: "apps", element: <Apps /> },
        { path: "vocabulary", element: <Vocabulary /> },
        { path: "history", element: <History /> },
        { path: "settings", element: <Settings /> },
        { path: "account", element: <Account /> },
      ],
    },
  ],
  { initialEntries: ["/"] },
);

export default function App() {
  return <RouterProvider router={router} />;
}

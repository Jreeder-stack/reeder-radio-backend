import { Switch, Route } from "wouter";
import { Toaster } from "@/components/ui/toaster";
import { RadioProvider } from "@/lib/radio-context";
import LoginPage from "@/pages/login";
import MainCommsPage from "@/pages/main-comms";
import CommsRadioPage from "@/pages/comms-radio";
import ScanMonitorPage from "@/pages/scan-monitor";
import SettingsPage from "@/pages/settings";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={LoginPage} />
      <Route path="/comms" component={MainCommsPage} />
      <Route path="/comms-radio" component={CommsRadioPage} />
      <Route path="/scan" component={ScanMonitorPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <RadioProvider>
      <Router />
      <Toaster />
    </RadioProvider>
  );
}

export default App;

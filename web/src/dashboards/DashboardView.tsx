import { Page, Section, Card, Row } from '../components/layout';
// UC-F replaces this handoff stub with the dashboard renderer.
export default function DashboardView(_props: { dashboardId?: string; id?: string; slug?: string }) {
  return <Page title="Dashboard"><Section><Card><Row title="Your dashboard will appear here" /></Card></Section></Page>;
}

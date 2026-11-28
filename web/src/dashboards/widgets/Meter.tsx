import type { PlanUsageSummary } from '@shared/plan-usage-types';
import { PlanUsageContent } from '../../components/PlanUsageContent';
import { Empty, type WidgetProps } from './shared';

export default function Meter({ widget, data }: WidgetProps) {
  if (!data?.value?.plan || !data.value.ownKeys) return <Empty widget={widget} text="Usage unavailable" action={false} />;
  return <PlanUsageContent summary={data.value as unknown as Pick<PlanUsageSummary, 'plan' | 'ownKeys'>} />;
}

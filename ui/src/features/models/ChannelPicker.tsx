import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { channels, isChannel, type Channel } from "./modelConfig.ts";

/** Eight segments do not fit a phone (their labels truncate), so there the channels are a list. */
export function ChannelPicker({
  channel,
  onChange,
}: {
  channel: Channel;
  onChange: (channel: Channel) => void;
}) {
  const isMobile = useAppShellMobile().isMobile;
  const choose = (value: string) => isChannel(value) && onChange(value);
  if (isMobile)
    return (
      <Selector
        label={t("models.page.channel")}
        isLabelHidden
        width="100%"
        value={channel}
        onChange={choose}
        options={channels.map((id) => ({ value: id, label: label(id) }))}
      />
    );
  return (
    <SegmentedControl label={t("models.page.channel")} value={channel} onChange={choose}>
      {channels.map((id) => (
        <SegmentedControlItem key={id} value={id} label={label(id)} />
      ))}
    </SegmentedControl>
  );
}

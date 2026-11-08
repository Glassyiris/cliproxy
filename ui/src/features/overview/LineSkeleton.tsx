import { HStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";

/**
 * One line of text still loading: an empty line of the text `role` holds the line's height, so the text
 * that replaces it moves nothing, and the bar sits in it as the table-filter template's loading
 * rows draw one bar per cell.
 */
export function LineSkeleton({
  role,
  index = 0,
}: {
  role: "body" | "supporting" | "metric";
  index?: number;
}) {
  return (
    <HStack gap={0} vAlign="center" wrap="nowrap" aria-hidden>
      <Text
        type={
          role === "metric"
            ? roles.textType.metric
            : role === "supporting"
              ? roles.textType.supporting
              : roles.textType.body
        }
      >
        {" "}
      </Text>
      <Skeleton
        width={layout.valueSkeleton.width}
        height={layout.valueSkeleton.height}
        index={index}
      />
    </HStack>
  );
}

export function categorySlug(value: string) {
  const text = value.trim().toLowerCase();
  if (!text) return "";
  if (text === "top" || text === "tops") return "tops";
  if (text.startsWith("bottom")) return "bottoms";
  if (text.startsWith("outer")) return "outerwear";
  return text
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

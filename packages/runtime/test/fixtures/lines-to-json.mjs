// A run's then: reads "- id | from | subject" lines on stdin and prints them as { items: [...] }.
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => (text += chunk));
process.stdin.on("end", () => {
  const items = text
    .split("\n")
    .filter(line => line.startsWith("- "))
    .map(line => {
      const [id, from, subject] = line.slice(2).split(" | ");
      return { id: Number(id), from, subject };
    });
  process.stdout.write(JSON.stringify({ items }));
});

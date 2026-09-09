/**
 * The three dots, shown only while an agent is actually mid-call.
 *
 * The one animation on the screen that is not the pulse, and it is here for the
 * same reason: something is happening that has not produced text yet, and the
 * alternative is a pane that looks broken.
 */
export const Typing = () => (
  <div className="flex gap-1 px-1 py-3" aria-label="working">
    {[0, 1, 2].map((index) => (
      <span
        key={index}
        className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
        style={{ animationDelay: `${index * 0.15}s` }}
      />
    ))}
  </div>
);

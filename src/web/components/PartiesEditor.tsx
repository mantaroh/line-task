export function PartiesEditor({
  parties,
  onChange,
  disabled,
}: {
  parties: string[];
  onChange: (parties: string[]) => void;
  disabled?: boolean;
}) {
  function setParty(i: number, value: string) {
    onChange(parties.map((p, idx) => (idx === i ? value : p)));
  }

  return (
    <fieldset className="field" disabled={disabled}>
      <legend>関係者</legend>
      {parties.map((p, i) => (
        <div className="party-row" key={i}>
          <input
            type="text"
            aria-label={`関係者 ${i + 1}`}
            value={p}
            onChange={(e) => setParty(i, e.target.value)}
            maxLength={12}
            required
          />
          {parties.length > 2 ? (
            <button type="button" className="btn" onClick={() => onChange(parties.filter((_, idx) => idx !== i))}>
              削除
            </button>
          ) : null}
        </div>
      ))}
      {parties.length < 5 ? (
        <button type="button" className="btn" onClick={() => onChange([...parties, ""])}>
          追加
        </button>
      ) : null}
    </fieldset>
  );
}

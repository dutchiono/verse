export function GuidePanel() {
  return (
    <div className="guide-panel">

      <div className="guide-hero">
        <h1 className="guide-title">How to use Verse</h1>
        <p className="guide-sub muted">Read this once before you fire anything real.</p>
      </div>

      <div className="guide-sections">

        {/* ── Wallets ── */}
        <section className="guide-section">
          <h2>Wallets</h2>
          <p>
            Verse uses <strong>vanity wallet pairs</strong>. Each pair is two Solana wallets whose
            addresses spell out a word — one wallet starts with the word (<code>BULL…</code>) and
            one ends with it (<code>…BULL</code>). Together they form one <em>word</em> in a sentence.
          </p>
          <p>
            The admin imports wallets through the <strong>Roster</strong> tab using a CSV produced
            by the grinder. Private keys are encrypted on the server and never leave it — they are
            not stored in git, not visible in the UI, and not transmitted to your browser.
          </p>
          <p>
            You also need one <strong>control wallet</strong> — a regular Solana wallet you already
            own. It acts as the bank: you fund it with SOL, ARM distributes that SOL to the
            sentence wallets, and Cleanup drains it all back when you're done.
          </p>
        </section>

        {/* ── The Sentence ── */}
        <section className="guide-section">
          <h2>The Sentence</h2>
          <p>
            A <strong>sentence</strong> is a sequence of wallet pairs. Each pair is a <em>word</em> — a
            prefix wallet and a suffix wallet that share the same label (e.g. <code>BULL</code>).
          </p>
          <p>
            You build your sentence by clicking words in the word picker at the bottom of the Dashboard.
            They stack into a queue. The sentence fires in order — step 1, then step 2, then step 3.
          </p>
          <p>
            You can save named sentences and reload them later from the Sequences rail on the left.
          </p>
        </section>

        {/* ── Action modes ── */}
        <section className="guide-section">
          <h2>Action Modes</h2>
          <div className="guide-modes">
            <div className="guide-mode guide-mode-rec">
              <div className="guide-mode-head">
                <span className="guide-mode-name">Buy + Sell</span>
                <span className="guide-rec-badge">recommended</span>
              </div>
              <p>
                Each step buys tokens with SOL, then immediately sells them back.
                This generates trading volume without building a net position.
                Use this unless you have a specific reason not to.
              </p>
            </div>
            <div className="guide-mode">
              <div className="guide-mode-head">
                <span className="guide-mode-name">Buy</span>
              </div>
              <p>
                Each step only buys. Wallets accumulate tokens. Requires SOL in each wallet.
              </p>
            </div>
            <div className="guide-mode">
              <div className="guide-mode-head">
                <span className="guide-mode-name">Sell</span>
              </div>
              <p>
                Each step only sells. Wallets must already hold tokens.
              </p>
            </div>
            <div className="guide-mode">
              <div className="guide-mode-head">
                <span className="guide-mode-name">Alternate</span>
              </div>
              <p>
                Odd steps buy, even steps sell (or vice versa).
              </p>
            </div>
          </div>
        </section>

        {/* ── Control wallet ── */}
        <section className="guide-section">
          <h2>The Control Wallet</h2>
          <p>
            The <strong>control wallet</strong> is the bank for your sentence. All SOL flows through it:
          </p>
          <ul className="guide-list">
            <li>You fund it before running ARM.</li>
            <li>ARM distributes SOL from it to every wallet in the queue.</li>
            <li>Cleanup drains all wallets back into it when you're done.</li>
            <li>You then Withdraw from the control wallet back to your own address.</li>
          </ul>
          <div className="guide-callout">
            <strong>How much to fund it?</strong><br />
            At minimum: <em>(number of steps × trade size) + (number of steps × ~0.003 SOL for gas)</em>.
            Add a buffer — gas estimates vary. If ARM fails partway through it's because the
            control wallet ran dry.
          </div>
        </section>

        {/* ── ARM ── */}
        <section className="guide-section">
          <h2>ARM</h2>
          <p>
            ARM sends SOL from the control wallet to each wallet in the queue so they can trade.
            Watch the status dots — they go from grey → blinking orange (sending) → green (armed).
          </p>
          <div className="guide-callout guide-callout-warn">
            <strong>Rate limit — you will need to ARM more than once.</strong><br />
            The RPC only allows a few transactions per second. If some wallets come back with an
            error dot, just hit <strong>ARM again</strong>. Keep going until every wallet in the
            queue shows a solid green dot. Two or three ARMs is normal.
          </div>
        </section>

        {/* ── Fire ── */}
        <section className="guide-section">
          <h2>Fire</h2>
          <p>
            Once all wallets are armed (green), you're ready to fire.
          </p>
          <ul className="guide-list">
            <li><strong>Manual:</strong> Press Fire once per step. Each press advances the cursor one position.</li>
            <li><strong>Auto-fire:</strong> Toggle it on and set an interval. The sequencer fires each step
                automatically and waits that interval between steps.</li>
          </ul>
          <p>
            The cursor position is shown in the status bar. Use Reset to start from the beginning.
          </p>
        </section>

        {/* ── Cleanup ── */}
        <section className="guide-section">
          <h2>Cleanup</h2>
          <p>
            Cleanup drains the remaining SOL from every wallet in the queue back to the control wallet.
            Run it when you're done firing.
          </p>
          <div className="guide-callout guide-callout-warn">
            <strong>Same rate limit as ARM — run Cleanup twice.</strong><br />
            Some wallets will fail on the first pass due to RPC throttling. Hit <strong>Cleanup again</strong>
            immediately after. Two passes clears everything in almost all cases.
          </div>
        </section>

        {/* ── Withdraw ── */}
        <section className="guide-section">
          <h2>Withdraw</h2>
          <p>
            After Cleanup the control wallet holds all the SOL. Use the <strong>Withdraw</strong> panel
            (shown above the sequencer on the Dashboard) to send it wherever you want — your personal
            wallet, a cold wallet, anywhere.
          </p>
          <p>
            Tick <strong>sweep</strong> to send the full balance minus a dust buffer, or enter an exact
            amount in SOL.
          </p>
        </section>

        {/* ── Typical flow ── */}
        <section className="guide-section guide-section-flow">
          <h2>Typical Flow</h2>
          <ol className="guide-steps">
            <li><span className="guide-step-num">1</span><span>Build your sentence — pick words from the word picker</span></li>
            <li><span className="guide-step-num">2</span><span>Set action mode to <strong>Buy + Sell</strong>, set trade size</span></li>
            <li><span className="guide-step-num">3</span><span>Fund the control wallet with enough SOL</span></li>
            <li><span className="guide-step-num">4</span><span>ARM — repeat until all dots are green</span></li>
            <li><span className="guide-step-num">5</span><span>FIRE manually or enable Auto-fire</span></li>
            <li><span className="guide-step-num">6</span><span>CLEANUP when done — repeat once if any wallets missed</span></li>
            <li><span className="guide-step-num">7</span><span>WITHDRAW from control wallet back to yourself</span></li>
          </ol>
        </section>

      </div>
    </div>
  );
}

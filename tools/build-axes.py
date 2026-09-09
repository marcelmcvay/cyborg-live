#!/usr/bin/env python3
"""
Build public/components.v2.json — the axis/vector model for the spider chart.

Replaces the 1-D "daily designer → Vader" spectrum. Rationale: a single axis
measures HOW MUCH cyborg, which contradicts the thesis. Everyone is already
one; what differs is SHAPE. Two people can enclose identical area and have
completely different silhouettes.

Scoring rubric — every axis 0..100, anchors below. Scores are authored
judgments, not measurements. Argue with them; that is the point.

  INTIMACY      how close to the body does the coupling sit
                5 ambient · 30 carried · 55 worn · 85 implanted · 95 metabolized

  DEPENDENCE    what breaks if it stops
                15 inconvenience · 40 friction · 65 impairment · 85 danger · 98 death

  AGENCY        who dispatches whom (HIGH = it dispatches you)
                10 you command · 50 mutual negotiation · 90 it dispatches you

  VISIBILITY    can others see the coupling
                5 invisible · 35 noticeable · 60 disclosed · 90 conspicuous

  CONSENT       how much choice you had (HIGH = less choice)
                10 freely chosen · 40 strongly normative · 60 medically necessary
                75 employer-mandated · 95 infrastructural / born into

  MASTERY       can you operate, fix, mod, own it (HIGH = you master it)
                10 sealed black box · 35 basic operation · 60 competent · 90 expert

  SURVEILLANCE  does the coupling report upstream
                5 reports nowhere · 25 local only · 60 vendor telemetry
                90 state / employer / third-party legible

POLARITY NOTE: MASTERY is the only axis where high is unambiguously good for
the wearer. The rest are descriptive, not moral. This is deliberate — a shape
should read as character, not score. If Marcel wants a uniformly-signed chart,
invert MASTERY into DEPENDENCY-ON-VENDOR and rename.

Run:  python3 tools/build-axes.py
Out:  public/components.v2.json  (does NOT touch the live components.json)
"""

import json
import os

AXES = [
    {"id": "INTIMACY",     "label": "Intimacy",     "short": "INTIM",
     "desc": "How close to the body the coupling sits.",
     "lo": "ambient", "hi": "metabolized"},
    {"id": "DEPENDENCE",   "label": "Dependence",   "short": "DEPEND",
     "desc": "What breaks if it stops.",
     "lo": "inconvenience", "hi": "death"},
    {"id": "AGENCY",       "label": "Agency Loss",  "short": "AGENCY",
     "desc": "Who dispatches whom. High means it dispatches you.",
     "lo": "you command", "hi": "it dispatches you"},
    {"id": "VISIBILITY",   "label": "Visibility",   "short": "VISIB",
     "desc": "Whether others can see the coupling.",
     "lo": "invisible", "hi": "conspicuous"},
    {"id": "CONSENT",      "label": "Consent Gap",  "short": "CONSENT",
     "desc": "How little choice you had. High means none.",
     "lo": "freely chosen", "hi": "born into it"},
    {"id": "MASTERY",      "label": "Mastery",      "short": "MASTERY",
     "desc": "Whether you can operate, fix, modify, own it.",
     "lo": "sealed black box", "hi": "expert / moddable"},
    {"id": "SURVEILLANCE", "label": "Surveillance", "short": "SURVEIL",
     "desc": "Whether the coupling reports upstream.",
     "lo": "reports nowhere", "hi": "state / employer legible"},
]

AXIS_IDS = [a["id"] for a in AXES]

GROUPS = [
    {"id": "BODY",      "label": "Body",     "hint": "prosthetic / wearable / bio",   "klass": "Exo-Steward"},
    {"id": "SENSES",    "label": "Senses",   "hint": "glasses, hearing, camera, GPS", "klass": "Sensor Witch"},
    {"id": "COGNITION", "label": "Cognition","hint": "LLM, search, notes, calendar",  "klass": "Curator"},
    {"id": "VOICE",     "label": "Voice",    "hint": "language, dialect, code, keys", "klass": "Linguist"},
    {"id": "VEHICLE",   "label": "Vehicle",  "hint": "car, bike, plane, exoskeleton", "klass": "Exo-Pilot"},
    {"id": "SOCIAL",    "label": "Social",   "hint": "feeds, messaging, payments",    "klass": "Interface Negotiator"},
    {"id": "CRAFT",     "label": "Craft",    "hint": "Figma, pen, terminal, DAW",     "klass": "Toolsmith"},
    {"id": "LABOR",     "label": "Labor",    "hint": "badge, work chat, scheduling",  "klass": "Shift Ghost"},
    {"id": "DOMESTIC",  "label": "Domestic", "hint": "heat, power, wifi, appliances", "klass": "Hearth Sysadmin"},
]

# id, label, group, [INTIM, DEPEND, AGENCY, VISIB, CONSENT, MASTERY, SURVEIL], blurb
# NEW items (not in v1) are marked with a trailing "*" in the comment column.
C = [
    # ── BODY ──────────────────────────────────────────────────────────
    ("body.glasses-contacts", "Corrective lenses", "BODY",
     [62, 70, 10, 30, 60, 45, 5],
     "The oldest mass-market body mod. Nobody calls you a cyborg for it. That's the point."),
    ("body.watch", "Smartwatch / fitness band", "BODY",
     [58, 30, 55, 40, 15, 35, 75],
     "A sensor strapped to the wrist that tells you how you slept. You believe it over yourself."),
    ("body.pacemaker", "Pacemaker / implant", "BODY",
     [92, 98, 70, 10, 75, 5, 65],
     "Firmware inside the chest cavity. Heartbeat as a scheduled task."),
    ("body.prosthetic", "Prosthetic limb", "BODY",
     [88, 85, 30, 75, 70, 50, 20],
     "Body schema extends to fit the tool. The tool becomes body. Merleau-Ponty was early."),
    ("body.meds", "Daily medication", "BODY",
     [95, 80, 45, 10, 65, 20, 30],
     "Chemistry-as-config. A dosage is a setting you don't get to hot-reload."),
    ("body.shoes", "Shoes", "BODY",
     [55, 45, 5, 45, 70, 55, 5],
     "Interface between foot and planet. Highly optimised, rarely considered."),
    ("body.dental", "Fillings / crowns / braces", "BODY",  # *
     [90, 50, 5, 25, 65, 5, 5],
     "Ceramic and metal, permanently installed in the skull. You stopped noticing on day three."),
    ("body.contraception", "Hormonal contraception / IUD", "BODY",  # *
     [93, 55, 40, 5, 35, 25, 30],
     "An endocrine system running a patch. Invisible, elective, and politically contested."),
    ("body.vaccination", "Vaccination", "BODY",  # *
     [88, 45, 20, 15, 70, 5, 70],
     "Your immune system was handed a threat signature it never encountered. Recorded in a state registry."),
    ("body.caffeine", "Caffeine / daily stimulant", "BODY",  # *
     [95, 55, 40, 20, 25, 45, 5],
     "A psychoactive dependency so normalised it has its own furniture. Skip a day, meet the baseline."),
    ("body.cpap", "CPAP / sleep apnea machine", "BODY",  # *
     [75, 80, 50, 30, 70, 25, 80],
     "A machine breathes with you all night and files a compliance report your insurer can read."),
    ("body.insulin", "Insulin pump / CGM", "BODY",  # *
     [90, 96, 65, 45, 80, 40, 75],
     "A closed loop keeping you alive. The DIY community jailbroke it because the vendor wouldn't ship."),

    # ── SENSES ────────────────────────────────────────────────────────
    ("senses.glasses", "Glasses (worn daily)", "SENSES",
     [58, 72, 8, 40, 60, 40, 5],
     "Vision is a rendering pipeline. You patched it."),
    ("senses.hearing", "Hearing aid / earbuds", "SENSES",
     [70, 55, 35, 35, 45, 40, 45],
     "Audio in, audio processed, audio out. The ear now has a DSP stage."),
    ("senses.camera", "Phone camera as memory", "SENSES",
     [30, 35, 25, 20, 20, 55, 70],
     "You photograph the parking spot so you don't have to remember it. Memory offloaded to sensor."),
    ("senses.gps", "GPS / maps", "SENSES",
     [30, 70, 65, 20, 45, 20, 90],
     "A satellite constellation tells you where you are. You've stopped checking."),
    ("senses.notifications", "Haptic notifications", "SENSES",
     [45, 35, 85, 15, 35, 30, 60],
     "A new sense: the buzz. It has no name in any pre-2007 language."),
    ("senses.night", "Dark mode / blue light filter", "SENSES",
     [20, 15, 15, 10, 10, 60, 5],
     "You tuned the colour temperature of reality between 21:00 and 07:00."),
    ("senses.noise", "Noise cancelling", "SENSES",  # *
     [65, 30, 20, 45, 15, 45, 30],
     "You subtract the city with a button. Selective deafness, sold as focus."),
    ("senses.doorbell", "Video doorbell / home camera", "SENSES",  # *
     [10, 25, 45, 55, 30, 15, 95],
     "You extended your perimeter vision and deputised it to the police department."),

    # ── COGNITION ─────────────────────────────────────────────────────
    ("cog.llm", "LLM assistant", "COGNITION",
     [25, 45, 50, 25, 20, 40, 80],
     "A second cortex you rent. Draft-thinking outsourced; judgement hopefully not."),
    ("cog.search", "Web search", "COGNITION",
     [25, 70, 40, 10, 40, 45, 85],
     "Transactive memory with a datacenter. You don't know it, you know where it is."),
    ("cog.notes", "Notes app / second brain", "COGNITION",
     [25, 55, 15, 10, 15, 65, 40],
     "An external hippocampus, tagged and searchable. Recall is now grep."),
    ("cog.calendar", "Calendar", "COGNITION",
     [25, 65, 70, 20, 55, 40, 65],
     "Your sense of time is a shared .ics file. Miss the sync, miss the meeting."),
    ("cog.autocorrect", "Autocorrect / predictive text", "COGNITION",
     [30, 30, 60, 15, 55, 20, 55],
     "A model finishes your sentences. Sometimes it's right. Sometimes it's ducking wrong."),
    ("cog.alarm", "Alarm clock", "COGNITION",
     [25, 60, 80, 10, 50, 60, 15],
     "Circadian rhythm overridden by cron. The first automation most humans install."),
    ("cog.translation", "Machine translation", "COGNITION",  # *
     [25, 40, 35, 30, 25, 30, 65],
     "A model stands between you and a stranger, and you both agree to trust it."),
    ("cog.recommendation", "Recommendation engine", "COGNITION",  # *
     [20, 35, 80, 15, 45, 10, 90],
     "Taste, precomputed. You think you chose it. The ranking chose it and let you feel authorship."),
    ("cog.password", "Password manager", "COGNITION",  # *
     [30, 85, 25, 10, 40, 50, 40],
     "Your entire identity behind one string you also can't remember. Single point of self."),

    # ── VOICE ─────────────────────────────────────────────────────────
    ("voice.language", "A natural language", "VOICE",
     [90, 95, 45, 70, 98, 70, 20],
     "Language IS technology. You were compiled into one before you could consent."),
    ("voice.dialect", "A dialect / code-switching", "VOICE",
     [85, 60, 35, 75, 80, 75, 25],
     "Runtime selection of protocol based on who's listening. Dialect is a driver."),
    ("voice.code", "A programming language", "VOICE",
     [55, 45, 25, 30, 15, 80, 20],
     "You speak to machines in a grammar with no irregular verbs. It changed how you think."),
    ("voice.keyboard", "Keyboard (touch-typing)", "VOICE",
     [45, 75, 10, 25, 45, 80, 15],
     "Thought exits through ten fingers at 80wpm. The keyboard has vanished from awareness."),
    ("voice.emoji", "Emoji / reactions", "VOICE",
     [30, 20, 20, 55, 25, 65, 35],
     "A pictographic layer bolted onto text. Tone, finally, has a codepoint."),
    ("voice.stt", "Voice-to-text / dictation", "VOICE",
     [35, 25, 45, 40, 20, 35, 75],
     "Speech transcribed by a model, edited by a thumb. Two systems, one utterance."),
    ("voice.sign", "Sign language", "VOICE",  # *
     [80, 70, 30, 80, 60, 75, 10],
     "A full language running on hands and face. Suppressed by institutions for a century, and it survived."),

    # ── VEHICLE ───────────────────────────────────────────────────────
    ("veh.bike", "Bicycle", "VEHICLE",
     [50, 40, 15, 65, 15, 75, 5],
     "The most efficient human-machine coupling ever shipped. Balance is done by the body-bike system."),
    ("veh.car", "Car", "VEHICLE",
     [40, 75, 35, 70, 70, 30, 70],
     "A two-tonne exoskeleton. You say 'I' when you mean 'the car'. ('Someone hit me.')"),
    ("veh.transit", "Public transit", "VEHICLE",
     [20, 60, 75, 50, 65, 10, 60],
     "Shared exoskeleton, timetable-driven. Assemblage at city scale."),
    ("veh.plane", "Airplane (as passenger)", "VEHICLE",
     [15, 30, 88, 40, 55, 5, 95],
     "Pressurised tube, 11km up. You watched a film and forgot you were a payload."),
    ("veh.exo", "Exoskeleton / powered mobility", "VEHICLE",
     [78, 70, 55, 90, 60, 35, 50],
     "Motors in the loop with your muscles. Closer to VADER than you'd like to admit."),
    ("veh.escooter", "E-bike / e-scooter", "VEHICLE",
     [45, 30, 30, 65, 15, 40, 55],
     "Battery-assisted legs. The hill is now a UI detail."),
    ("veh.elevator", "Elevator / escalator", "VEHICLE",  # *
     [10, 55, 60, 20, 85, 5, 45],
     "Vertical transit you never chose, cannot inspect, and organise entire cities around."),
    ("veh.wheelchair", "Wheelchair", "VEHICLE",  # *
     [70, 95, 20, 85, 75, 70, 10],
     "The chair is not the limitation. The stairs are. Users are expert mechanics of their own mobility."),

    # ── SOCIAL ────────────────────────────────────────────────────────
    ("soc.messaging", "Messaging app", "SOCIAL",
     [30, 70, 55, 25, 60, 35, 75],
     "Your relationships have a transport layer. It has read receipts."),
    ("soc.feed", "Social feed", "SOCIAL",
     [25, 40, 85, 30, 35, 15, 95],
     "An algorithm curates what you see of other humans. Steward it or be stewarded."),
    ("soc.payments", "Contactless payments", "SOCIAL",
     [30, 65, 30, 25, 65, 15, 90],
     "Value transfers by proximity. Money became a gesture."),
    ("soc.id", "Digital ID / passport chip", "SOCIAL",
     [35, 80, 60, 35, 95, 5, 98],
     "Who you are, as far as the state is concerned, is an NFC read."),
    ("soc.calendar-shared", "Shared calendars / invites", "SOCIAL",
     [20, 55, 80, 30, 70, 30, 70],
     "Other people can write to your time. Negotiate the permissions."),
    ("soc.dating", "Dating app", "SOCIAL",  # *
     [25, 30, 75, 30, 30, 10, 88],
     "Intimacy, ranked and rate-limited. The matching function is a trade secret."),
    ("soc.review", "Ratings / star scores", "SOCIAL",  # *
     [15, 35, 70, 40, 55, 10, 80],
     "You are scored by strangers and the score precedes you into every room."),
    ("soc.credit", "Credit score", "SOCIAL",  # *
     [10, 85, 88, 15, 95, 5, 95],
     "A number you never applied for decides where you may live. Nobody will show you the model."),

    # ── CRAFT ─────────────────────────────────────────────────────────
    ("craft.figma", "Figma / design tool", "CRAFT",
     [30, 65, 30, 25, 55, 70, 60],
     "Your visual thinking lives in someone else's multiplayer canvas. Cmd+Z is part of your hand."),
    ("craft.pen", "Pen & notebook", "CRAFT",
     [40, 25, 5, 30, 10, 85, 5],
     "Ancient write-head. Still the lowest-latency thought interface available."),
    ("craft.terminal", "Terminal / shell", "CRAFT",
     [35, 60, 15, 20, 15, 95, 25],
     "Text in, consequences out. The most honest interface: it tells you exactly what it did."),
    ("craft.daw", "DAW / synth", "CRAFT",
     [30, 30, 20, 25, 10, 75, 30],
     "Time-domain editing of sound. Undo for music. Bach didn't have that."),
    ("craft.instrument", "Guitar / instrument", "CRAFT",
     [55, 25, 10, 60, 5, 85, 5],
     "Wood and wire that disappears when played. Peak transparent tool."),
    ("craft.camera", "Camera (as craft)", "CRAFT",
     [35, 30, 15, 55, 10, 75, 35],
     "Framing is a cognitive act performed through glass. You see differently with it on you."),
    ("craft.spreadsheet", "Spreadsheet", "CRAFT",  # *
     [25, 60, 25, 25, 50, 70, 35],
     "The most consequential programming environment on earth, operated almost entirely by non-programmers."),
    ("craft.handtools", "Sewing machine / hand tools", "CRAFT",  # *
     [35, 15, 5, 35, 5, 85, 5],
     "Fully ownable, fully repairable, reports to nobody. The control case for everything else here."),
    ("craft.genai", "Generative image tools", "CRAFT",  # *
     [25, 25, 55, 35, 15, 35, 70],
     "You describe, it renders, and authorship becomes a question rather than a fact."),

    # ── LABOR ─────────────────────────────────────────────────────────
    ("labor.badge", "Access badge / keycard", "LABOR",  # *
     [30, 70, 65, 45, 88, 5, 92],
     "A door decides whether you exist here, and logs the question either way."),
    ("labor.chat", "Workplace chat", "LABOR",  # *
     [30, 75, 80, 30, 85, 25, 90],
     "Presence as a green dot. Availability became a rendered UI state your manager can read."),
    ("labor.timetrack", "Time tracking / timesheet", "LABOR",  # *
     [20, 60, 85, 35, 92, 5, 95],
     "Your hours are a data structure someone else validates."),
    ("labor.email", "Work email", "LABOR",  # *
     [30, 80, 75, 25, 85, 35, 88],
     "An inbox that assigns you tasks. You did not agree to the queue discipline."),
    ("labor.mdm", "Managed device / MDM / VPN", "LABOR",  # *
     [35, 65, 70, 15, 90, 5, 96],
     "Your employer holds root on a machine you carry in your pocket to dinner."),
    ("labor.dispatch", "Algorithmic dispatch / shift scheduler", "LABOR",  # *
     [25, 85, 95, 25, 90, 5, 95],
     "The route, the pace, and the shift arrive from a model. Peak dispatch. No appeal path."),

    # ── DOMESTIC ──────────────────────────────────────────────────────
    ("dom.thermostat", "Smart thermostat", "DOMESTIC",  # *
     [10, 40, 55, 15, 40, 20, 75],
     "The utility can raise your temperature remotely on a demand-response event. You agreed in a rebate form."),
    ("dom.speaker", "Smart speaker / voice assistant", "DOMESTIC",  # *
     [20, 25, 50, 40, 20, 15, 92],
     "A microphone you paid for, installed yourself, and named."),
    ("dom.washing", "Washing machine", "DOMESTIC",  # *
     [10, 70, 25, 15, 45, 40, 5],
     "Arguably the most liberating machine of the twentieth century. It gave back a day a week."),
    ("dom.fridge", "Refrigerator", "DOMESTIC",  # *
     [10, 85, 15, 10, 70, 25, 5],
     "A continuously-powered cold pocket without which your diet collapses to what is in season."),
    ("dom.power", "Mains electricity", "DOMESTIC",  # *
     [5, 96, 40, 5, 97, 5, 55],
     "The substrate every other item here runs on. Invisible until the grid drops."),
    ("dom.wifi", "Home broadband / wifi", "DOMESTIC",  # *
     [10, 90, 45, 5, 80, 30, 85],
     "Your dwelling has a nervous system, and it is rented from a monopoly."),
]

# ── Ghost reference polygons ──────────────────────────────────────────
# Authored directly, NOT derived from picks. These replace the old
# "daily designer → Vader" line: famous cyborgs stop being endpoints on a
# scale and become silhouettes you can lay behind your own.
GHOSTS = [
    {"id": "ghost.rat", "label": "Clynes & Kline's rat", "year": 1960,
     "vector": [95, 92, 88, 60, 100, 0, 70],
     "note": "The osmotic-pump rat from the paper that coined 'cyborg'. Total consent gap, "
             "zero mastery. The word was born describing something done TO a body."},
    {"id": "ghost.astronaut", "label": "Mercury-era astronaut", "year": 1962,
     "vector": [70, 96, 80, 95, 55, 45, 98],
     "note": "Clynes & Kline's actual proposal was to modify the human so the capsule could be "
             "simpler. NASA built the capsule instead. Attribute the framing, don't assert intent."},
    {"id": "ghost.vader", "label": "Darth Vader", "year": 1977,
     "vector": [95, 98, 40, 100, 85, 55, 15],
     "note": "Maximum visibility and intimacy, but note the LOW surveillance and mid agency-loss. "
             "Fiction's cyborg is conspicuous and self-directed. Ours is invisible and dispatched. "
             "That inversion is the talk."},
    {"id": "ghost.farmer", "label": "Farmer, 1890", "year": 1890,
     "vector": [45, 60, 20, 40, 50, 90, 5],
     "note": "The control case. Deeply coupled to tools and animals, near-total mastery over all of "
             "them, legible to nobody. Not less cyborg — differently shaped."},
    {"id": "ghost.room", "label": "This room (live)", "year": None,
     "vector": None,
     "note": "Computed at runtime from the audience mean. Never hardcode."},
]


def build():
    by_id = {}
    comps = []
    for cid, label, group, vec, blurb in C:
        assert cid not in by_id, f"duplicate component id {cid}"
        assert group in {g["id"] for g in GROUPS}, f"{cid}: unknown group {group}"
        assert len(vec) == len(AXIS_IDS), f"{cid}: {len(vec)} scores, need {len(AXIS_IDS)}"
        for ax, v in zip(AXIS_IDS, vec):
            assert isinstance(v, int) and 0 <= v <= 100, f"{cid}.{ax} out of range: {v}"
        by_id[cid] = True
        comps.append({
            "id": cid,
            "label": label,
            "group": group,
            "blurb": blurb,
            "vector": dict(zip(AXIS_IDS, vec)),
        })

    for g in GHOSTS:
        if g["vector"] is not None:
            assert len(g["vector"]) == len(AXIS_IDS), f"ghost {g['id']} wrong arity"
            g["vector"] = dict(zip(AXIS_IDS, g["vector"]))

    return {
        "version": 2,
        "supersedes": "spectrum (1-D daily-designer→vader scale)",
        "aggregation": {
            "method": "mean",
            "note": "MEAN, not sum. Sum makes more picks = bigger polygon, which rebuilds the "
                    "scoreboard the spectrum was removed for. Mean makes shape = character. "
                    "Surface pick COUNT separately (polygon opacity / fill density), never as radius.",
            "axisOrder": AXIS_IDS,
            "axisOrderNote": "FIXED. Radar silhouettes change dramatically with spoke order on "
                             "identical data. Never sort spokes by value.",
            "scoring": "Never rank participants by enclosed area. Perceived area scales with r^2, "
                       "so area is a misleading and un-authored metric.",
        },
        "axes": AXES,
        "groups": GROUPS,
        "components": comps,
        "ghosts": GHOSTS,
    }


if __name__ == "__main__":
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(here, "public", "components.v2.json")
    data = build()
    with open(out, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    n_new = sum(1 for c in data["components"] if c["group"] in ("LABOR", "DOMESTIC"))
    print(f"wrote {out}")
    print(f"  axes       {len(data['axes'])}")
    print(f"  groups     {len(data['groups'])}  (2 new: LABOR, DOMESTIC)")
    print(f"  components {len(data['components'])}  ({n_new} in new groups)")
    print(f"  ghosts     {len(data['ghosts'])}")
    print(f"  scores     {len(data['components']) * len(data['axes'])}")

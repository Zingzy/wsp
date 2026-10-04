// SPDX-License-Identifier: AGPL-3.0-only
// Appendix C of the spec, "A step-by-step setup the person performs", in its stored form as the spec's checker
// compiled it, with the two corrections the proof of concept applies: the token reaches vercel through its
// environment and gh through stdin, never as an argument.
import type { SlateDoc } from "@wsp/protocol";

export const APPENDIX_C: SlateDoc = {
  "schema": 2,
  "title": "Deploy setup",
  "root": "column-1",
  "values": {
    "step": {
      "start": 1
    },
    "repo": {
      "start": "Zingzy/wsp-landing"
    },
    "project": {
      "start": ""
    },
    "vercelToken": {
      "start": null,
      "secret": true
    }
  },
  "derived": {
    "checked": "$check.state == 'done' and contains($check.out, $project)",
    "written": "$env.state == 'done' and $ci.state == 'done'"
  },
  "runs": {
    "check": {
      "kind": "cmd",
      "cmd": "vercel project inspect \"$PROJECT\" 2>&1 | head -c 4000",
      "env": {
        "PROJECT": {
          "bind": "$project"
        },
        "VERCEL_TOKEN": {
          "bind": "$vercelToken"
        }
      },
      "on": "host",
      "timeout": 30
    },
    "env": {
      "kind": "cmd",
      "cmd": "grep -v \"^VERCEL_TOKEN=\" .env > .env.tmp 2>/dev/null; printf \"VERCEL_TOKEN=%s\\n\" \"$VERCEL_TOKEN\" >> .env.tmp; mv .env.tmp .env",
      "env": {
        "VERCEL_TOKEN": {
          "bind": "$vercelToken"
        }
      },
      "on": "host",
      "timeout": 10
    },
    "ci": {
      "kind": "cmd",
      "cmd": "gh secret set VERCEL_TOKEN --repo \"$REPO\"",
      "env": {
        "REPO": {
          "bind": "$repo"
        }
      },
      "stdin": {
        "bind": "$vercelToken"
      },
      "on": "host",
      "timeout": 60
    }
  },
  "reactions": [
    {
      "on": {
        "change": [
          "$project"
        ]
      },
      "do": [
        {
          "do": "start",
          "run": "check"
        }
      ]
    },
    {
      "on": {
        "change": [
          "$checked"
        ]
      },
      "do": [
        {
          "do": "set",
          "path": "$step",
          "value": {
            "bind": "$checked ? 3 : 2"
          }
        }
      ]
    },
    {
      "on": {
        "change": [
          "$written"
        ]
      },
      "do": [
        {
          "do": "set",
          "path": "$step",
          "value": {
            "bind": "$written ? 4 : 3"
          }
        }
      ]
    }
  ],
  "pieces": {
    "text-1": {
      "type": "text",
      "props": {
        "emphasis": "strong",
        "value": {
          "format": "Step ${$step} of 4"
        }
      }
    },
    "markdown-1": {
      "type": "markdown",
      "props": {
        "value": "Open the Vercel dashboard, make a token with the project's scope, and paste it here. It never reaches the agent."
      }
    },
    "button-1": {
      "type": "button",
      "props": {
        "label": "Open Vercel tokens"
      },
      "on": {
        "press": [
          {
            "do": "open",
            "target": "https://vercel.com/account/tokens"
          }
        ]
      }
    },
    "input-1": {
      "type": "input",
      "props": {
        "label": "Vercel token",
        "value": {
          "bind": "$vercelToken"
        },
        "kind": "password"
      }
    },
    "button-2": {
      "type": "button",
      "when": "$vercelToken.set",
      "props": {
        "label": "Next",
        "variant": "primary"
      },
      "on": {
        "press": [
          {
            "do": "set",
            "path": "$step",
            "value": 2
          }
        ]
      }
    },
    "section-1": {
      "type": "section",
      "when": "$step == 1",
      "props": {
        "title": "1. The Vercel token"
      },
      "children": [
        "markdown-1",
        "button-1",
        "input-1",
        "button-2"
      ]
    },
    "project-name": {
      "type": "input",
      "props": {
        "label": "Project name on Vercel",
        "value": {
          "bind": "$project"
        },
        "mono": true
      }
    },
    "text-2": {
      "type": "text",
      "when": "$check.state == 'held'",
      "props": {
        "tone": "muted",
        "value": "Approve the check to go on"
      }
    },
    "text-3": {
      "type": "text",
      "when": "$check.state == 'running'",
      "props": {
        "tone": "muted",
        "value": "Checking"
      }
    },
    "text-4": {
      "type": "text",
      "when": "$check.state == 'failed'",
      "props": {
        "tone": "bad",
        "value": {
          "format": "Vercel did not find it: ${short($check.err, 160)}"
        }
      }
    },
    "text-5": {
      "type": "text",
      "when": "$checked",
      "props": {
        "tone": "good",
        "value": {
          "format": "Found ${$project}"
        }
      }
    },
    "section-2": {
      "type": "section",
      "when": "$step == 2 or $step == 3",
      "props": {
        "title": "2. The project"
      },
      "children": [
        "project-name",
        "text-2",
        "text-3",
        "text-4",
        "text-5"
      ]
    },
    "facts-1": {
      "type": "facts",
      "props": {
        "facts": [
          {
            "label": "Repo",
            "value": {
              "bind": "$repo"
            },
            "mono": true
          },
          {
            "label": "Project",
            "value": {
              "bind": "$project"
            },
            "mono": true
          }
        ]
      }
    },
    "button-3": {
      "type": "button",
      "when": "$env.state != 'done'",
      "props": {
        "label": "Write .env"
      },
      "on": {
        "press": [
          {
            "do": "start",
            "run": "env"
          }
        ]
      }
    },
    "button-4": {
      "type": "button",
      "when": "$ci.state != 'done'",
      "props": {
        "label": "Set the CI secret"
      },
      "on": {
        "press": [
          {
            "do": "start",
            "run": "ci"
          }
        ]
      }
    },
    "row-1": {
      "type": "row",
      "children": [
        "button-3",
        "button-4"
      ]
    },
    "text-6": {
      "type": "text",
      "when": "$env.state == 'done'",
      "props": {
        "tone": "good",
        "value": ".env written"
      }
    },
    "text-7": {
      "type": "text",
      "when": "$ci.state == 'done'",
      "props": {
        "tone": "good",
        "value": "CI secret set"
      }
    },
    "text-8": {
      "type": "text",
      "when": "$env.state == 'failed' or $ci.state == 'failed'",
      "props": {
        "tone": "bad",
        "value": {
          "format": "${short(concat($env.err, $ci.err), 200)}"
        }
      }
    },
    "section-3": {
      "type": "section",
      "when": "$step == 3",
      "props": {
        "title": "3. Write it down"
      },
      "children": [
        "facts-1",
        "row-1",
        "text-6",
        "text-7",
        "text-8"
      ]
    },
    "text-9": {
      "type": "text",
      "props": {
        "tone": "good",
        "value": "The token is in .env and in the repo's secrets."
      }
    },
    "write": {
      "type": "button",
      "props": {
        "label": "Tell the agent",
        "variant": "primary"
      },
      "on": {
        "press": [
          {
            "do": "send",
            "text": "The Vercel setup is done on the slate; wire the deploy hook next.",
            "with": [
              "$repo",
              "$project",
              "$vercelToken"
            ]
          }
        ]
      }
    },
    "section-4": {
      "type": "section",
      "when": "$step == 4",
      "props": {
        "title": "4. Done"
      },
      "children": [
        "text-9",
        "write"
      ]
    },
    "column-1": {
      "type": "column",
      "children": [
        "text-1",
        "section-1",
        "section-2",
        "section-3",
        "section-4"
      ]
    }
  }
};

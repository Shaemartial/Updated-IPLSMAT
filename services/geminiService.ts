import { GoogleGenAI } from "@google/genai";
import { Player, DetailedStats, PlayerRole } from "../types";

const apiKey = process.env.API_KEY; 
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// Helper to clean and parse JSON from Markdown response
const cleanAndParseJSON = (text: string) => {
  try {
    // 1. Try direct parse
    return JSON.parse(text);
  } catch (e) {
    // 2. Try extracting from markdown code blocks
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (e2) {
        // Continue to step 3
      }
    }
    
    // 3. Try finding the first '{' and last '}'
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      try {
        return JSON.parse(text.substring(start, end + 1));
      } catch (e3) {
         throw new Error("Failed to parse JSON from response");
      }
    }
    throw new Error("No JSON found in response");
  }
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const fetchLatestPlayerStats = async (player: Player): Promise<{ stats: Partial<DetailedStats>, role: PlayerRole, source?: string }> => {
  if (!ai) {
    throw new Error("API Key not found.");
  }

  const model = "gemini-2.5-flash"; 
  
  // FINAL FIX STRATEGY: DUAL-STREAM EXTRACTION
  // 1. Do not assume role. Extract BOTH batting and bowling for every match.
  // 2. Explicitly handle "DNB" (Did Not Bat) to fix the Match vs Innings count.
  // 3. Verify specific match opponents to avoid "random games".
  
  const prompt = `
    You are a Professional Cricket Scorer.
    
    TARGET:
    - Player: "${player.name}"
    - Team: "${player.smatTeam}"
    - Tournament: Syed Mushtaq Ali Trophy 2025 (SMAT)
    - Period: Nov 2025 - Dec 2025
    
    **YOUR MISSION:**
    Build a precise match-by-match log.

    **SEARCH QUERY:**
    site:espncricinfo.com OR site:cricbuzz.com OR site:bcci.tv "${player.name}" "${player.smatTeam}" Syed Mushtaq Ali Trophy 2025 scorecard

    **EXTRACTION PROTOCOL (STRICT):**
    
    1. **FIND MATCHES**:
       - Identify confirmed matches played by "${player.smatTeam}" where "${player.name}" was in the Playing XI.
       - **IGNORE** matches where he was on the bench.
    
    2. **FOR EACH MATCH FOUND (Dual-Stream Check)**:
       - **Check Batting**: 
         - Search for runs/balls (e.g., "14(10)"). 
         - **Important**: If he played (e.g., bowled) but did not bat, mark Batting as "**DNB**".
       - **Check Bowling**: 
         - Search for figures (e.g., "4-0-24-2" or "2/24"). 
         - If he did not bowl, mark Bowling as "**-**".
    
    3. **VERIFY SCORES**:
       - "14(10)" = 14 Runs, 10 Balls.
       - "4/20" = 4 Wickets, 20 Runs.
       - Do not mix these up.

    4. **CALCULATE TOTALS (Sum of Log Only)**:
       - **matches**: Count of games where (Batting != null OR Bowling != null).
       - **innings**: Count of games where Batting != "DNB" and Batting != "-".
       - **runs**: Sum of batting runs.
       - **wickets**: Sum of bowling wickets.
       - **highestScore**: Max score from batting.
       - **bestBowling**: Best figures from bowling.

    **OUTPUT JSON FORMAT:**
    {
      "matchLog": [
        { 
          "opponent": "vs TeamName", 
          "date": "DD MMM", 
          "batting": "e.g. 24(12) or DNB", 
          "bowling": "e.g. 2/24 or -"
        }
      ],
      "totals": {
        "matches": number,
        "innings": number,
        "runs": number,
        "ballsFaced": number,
        "highestScore": string,
        "battingAverage": number,
        "battingStrikeRate": number,
        "wickets": number,
        "runsConceded": number,
        "overs": number,
        "economy": number,
        "bestBowling": string
      },
      "derivedRole": "Batsman" | "Bowler" | "All-Rounder" | "Wicket Keeper",
      "summary": "Brief summary of performance."
    }
  `;

  let attempts = 0;
  const maxAttempts = 3;
  let delay = 2000;

  while (attempts < maxAttempts) {
    try {
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
      const sourceUrl = groundingMetadata?.groundingChunks?.[0]?.web?.uri;
      
      const text = response.text;
      if (!text) throw new Error("No response from AI");

      const data = cleanAndParseJSON(text);

      // Map the AI's "matchLog" to the app's "recentMatches" format
      // We combine batting and bowling into a single "performance" string for the UI
      const mappedRecentMatches = (data.matchLog || []).map((m: any) => {
        let perf = "";
        if (m.batting && m.batting !== "-" && m.batting !== "DNB") perf += `🏏 ${m.batting} `;
        else if (m.batting === "DNB") perf += `🏏 DNB `;
        
        if (m.bowling && m.bowling !== "-" && m.bowling !== "DNB") perf += `🏐 ${m.bowling}`;
        
        return {
          opponent: m.opponent,
          date: m.date,
          performance: perf.trim() || "Played"
        };
      });

      return {
        stats: {
          matches: data.totals?.matches || 0,
          innings: data.totals?.innings || 0,
          runs: data.totals?.runs || 0,
          ballsFaced: data.totals?.ballsFaced || 0,
          battingAverage: data.totals?.battingAverage,
          battingStrikeRate: data.totals?.battingStrikeRate,
          highestScore: data.totals?.highestScore,
          
          overs: data.totals?.overs || 0,
          wickets: data.totals?.wickets || 0,
          runsConceded: data.totals?.runsConceded,
          economy: data.totals?.economy,
          bowlingAverage: 0, // AI often struggles with this derived stat, simpler to omit or calc if needed
          bowlingStrikeRate: 0,
          bestBowling: data.totals?.bestBowling,
          
          recentMatches: mappedRecentMatches,
          summary: data.summary,
          lastUpdated: new Date().toISOString()
        },
        role: data.derivedRole || 'Unknown',
        source: sourceUrl
      };

    } catch (error: any) {
      console.error(`Attempt ${attempts + 1} failed:`, error);
      
      const isQuotaError = error.status === 429 || 
                           (error.message && (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('quota')));

      if (isQuotaError && attempts < maxAttempts - 1) {
        console.warn(`Quota hit. Retrying in ${delay}ms...`);
        await wait(delay);
        delay *= 2; 
        attempts++;
        continue;
      }
      
      if (isQuotaError) {
        throw new Error("API Usage Limit Reached. Please wait a minute before trying again.");
      }

      throw error;
    }
  }
  
  throw new Error("Failed to fetch stats after multiple attempts.");
};

import express, { Request, Response } from 'express';
import cors from 'cors';
import { BracketsManager } from 'brackets-manager';
import { JsonDatabase } from 'brackets-json-db';
import path from 'path';
import fs from 'fs';

const app = express();
const PORT = 3000;

// Initialize data directory
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize brackets manager with data directory
const storage = new JsonDatabase(path.join(dataDir, 'db.json'));
const manager = new BracketsManager(storage);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API Routes

// Get all tournaments (stages)
app.get('/api/stages', async (req: Request, res: Response) => {
  try {
    const stages = await storage.select('stage');
    res.json(stages || []);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stages' });
  }
});

// Get specific stage
app.get('/api/stages/:id', async (req: Request, res: Response) => {
  try {
    const stage = await storage.select('stage', { id: parseInt(req.params.id) });
    if (!stage || stage.length === 0) {
      return res.status(404).json({ error: 'Stage not found' });
    }
    res.json(stage[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stage' });
  }
});

// Get matches for a stage
app.get('/api/stages/:id/matches', async (req: Request, res: Response) => {
  try {
    const matches = await storage.select('match', { stage_id: parseInt(req.params.id) });
    res.json(matches || []);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// Get all matches
app.get('/api/matches', async (req: Request, res: Response) => {
  try {
    const matches = await storage.select('match');
    res.json(matches || []);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// Create a new stage
app.post('/api/stages', async (req: Request, res: Response) => {
  try {
    const { tournamentId, name, type, seeding, settings, eventName } = req.body;

    if (!tournamentId || !name || !type || !seeding) {
      return res.status(400).json({ 
        error: 'Missing required fields: tournamentId, name, type, seeding' 
      });
    }

    const stage = await manager.create.stage({
      tournamentId,
      name,
      type,
      seeding,
      settings: settings || {}
    });

    // Add event_name to the stage if provided
    if (eventName && stage) {
      const stageId = (stage as any).id;
      // Read current stage data
      const currentStage = await storage.select('stage', { id: stageId });
      if (currentStage && currentStage[0]) {
        // Merge event_name with existing data
        const updatedData = { ...currentStage[0], event_name: eventName };
        await storage.update('stage', stageId, updatedData as any);
        return res.status(201).json(updatedData);
      }
    }

    res.status(201).json(stage);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to create stage' });
  }
});

// Update match result
app.put('/api/matches/:id', async (req: Request, res: Response) => {
  try {
    const { opponent1, opponent2 } = req.body;
    const matchId = parseInt(req.params.id);

    await manager.update.match({
      id: matchId,
      opponent1,
      opponent2
    });

    const updatedMatch = await storage.select('match', { id: matchId });
    res.json(updatedMatch?.[0] || {});
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update match' });
  }
});

// Delete a stage
app.delete('/api/stages/:id', async (req: Request, res: Response) => {
  try {
    await manager.delete.stage(parseInt(req.params.id));
    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete stage' });
  }
});

// Get participants
app.get('/api/participants', async (req: Request, res: Response) => {
  try {
    const participants = await storage.select('participant');
    res.json(participants || []);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch participants' });
  }
});

// Create participant
app.post('/api/participants', async (req: Request, res: Response) => {
  try {
    const { tournamentId, name } = req.body;
    
    if (!tournamentId || !name) {
      return res.status(400).json({ 
        error: 'Missing required fields: tournamentId, name' 
      });
    }

    const participant = await storage.insert('participant', {
      tournament_id: tournamentId,
      name: name
    });

    res.status(201).json(participant);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to create participant' });
  }
});

// Delete participant
app.delete('/api/participants/:id', async (req: Request, res: Response) => {
  try {
    await storage.delete('participant', { id: parseInt(req.params.id) });
    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete participant' });
  }
});

// Get complete tournament data for viewer
app.get('/api/viewer-data/:stageId', async (req: Request, res: Response) => {
  try {
    const stageId = parseInt(req.params.stageId);
    
    const stage = await storage.select('stage', { id: stageId });
    const matches = await storage.select('match', { stage_id: stageId });
    
    // Try to get match_game data, but don't fail if it doesn't exist
    let matchGames: any[] = [];
    try {
      matchGames = await storage.select('match_game', { stage_id: stageId }) || [];
    } catch (e) {
      // match_game table might not exist, that's ok
      console.log('match_game table not available');
    }
    
    // Get all participants for this stage
    const stage_data: any = stage?.[0];
    if (!stage_data) {
      return res.status(404).json({ error: 'Stage not found' });
    }

    // Get all participants for this tournament
    const allParticipants = await storage.select('participant');
    const stageParticipants = allParticipants?.filter((p: any) => 
      p.tournament_id === stage_data.tournament_id
    );

    res.json({
      stage: stage || [],
      match: matches || [],
      match_game: matchGames,
      participant: stageParticipants || []
    });
  } catch (error: any) {
    console.error('Error fetching viewer data:', error);
    res.status(500).json({ error: 'Failed to fetch viewer data', details: error.message });
  }
});

// Get final standings/placements for a stage
app.get('/api/standings/:stageId', async (req: Request, res: Response) => {
  try {
    const stageId = parseInt(req.params.stageId);
    
    const stage: any = await storage.select('stage', { id: stageId });
    const matches: any = await storage.select('match', { stage_id: stageId });
    const groups: any = await storage.select('group', { stage_id: stageId });
    const rounds: any = await storage.select('round', { stage_id: stageId });
    
    if (!stage || stage.length === 0) {
      return res.status(404).json({ error: 'Stage not found' });
    }
    
    const stageData = stage[0];
    const allParticipants: any = await storage.select('participant');
    const stageParticipants = allParticipants?.filter((p: any) => 
      p.tournament_id === stageData.tournament_id
    );
    
    // Calculate placements based on bracket structure
    const placements = calculatePlacements(stageData, matches, groups, rounds, stageParticipants);
    
    res.json(placements);
  } catch (error: any) {
    console.error('Error fetching standings:', error);
    res.status(500).json({ error: 'Failed to fetch standings', details: error.message });
  }
});

function calculatePlacements(stage: any, matches: any[], groups: any[], rounds: any[], participants: any[]) {
  const placements: any[] = [];
  
  if (stage.type === 'double_elimination') {
    // For double elimination, we need to track final match results
    // Winner = champion, runner-up = grand final loser, 3rd = LB final loser, etc.
    
    const participantData = new Map();
    
    participants.forEach((p: any) => {
      if (!p.name) return; // Skip BYE
      participantData.set(p.id, {
        id: p.id,
        name: p.name,
        wins: 0,
        losses: 0,
        finalMatch: null, // The last match they played
        finalMatchRound: 0,
        finalMatchGroup: 0,
        wonFinalMatch: false
      });
    });
    
    // Find the highest round numbers to identify finals
    const maxRoundByGroup = new Map();
    rounds.forEach((round: any) => {
      const current = maxRoundByGroup.get(round.group_id) || 0;
      if (round.number > current) {
        maxRoundByGroup.set(round.group_id, round.number);
      }
    });
    
    // Process all matches to track participant progress
    matches.forEach((match: any) => {
      if (!match.opponent1?.id || !match.opponent2?.id) return;
      if (!match.opponent1?.result && !match.opponent2?.result) return; // Skip unplayed matches
      
      const p1 = participantData.get(match.opponent1.id);
      const p2 = participantData.get(match.opponent2.id);
      
      if (!p1 || !p2) return;
      
      const round = rounds.find((r: any) => r.id === match.round_id);
      const group = groups.find((g: any) => g.id === match.group_id);
      
      if (!round || !group) return;
      
      const winner = match.opponent1?.result === 'win' ? p1 : p2;
      const loser = match.opponent1?.result === 'win' ? p2 : p1;
      
      winner.wins++;
      loser.losses++;
      
      // Update final match for both players
      const isLaterMatch = (group.number > winner.finalMatchGroup) || 
                          (group.number === winner.finalMatchGroup && round.number > winner.finalMatchRound);
      
      if (isLaterMatch || !winner.finalMatch) {
        winner.finalMatch = match;
        winner.finalMatchRound = round.number;
        winner.finalMatchGroup = group.number;
        winner.wonFinalMatch = true;
      }
      
      const isLaterMatchLoser = (group.number > loser.finalMatchGroup) || 
                               (group.number === loser.finalMatchGroup && round.number > loser.finalMatchRound);
      
      if (isLaterMatchLoser || !loser.finalMatch) {
        loser.finalMatch = match;
        loser.finalMatchRound = round.number;
        loser.finalMatchGroup = group.number;
        loser.wonFinalMatch = false;
      }
    });
    
    // Sort by final placement:
    // 1. Players who won their final match and reached later rounds are ranked higher
    // 2. Among those eliminated in the same round, more wins = better
    const standings = Array.from(participantData.values())
      .sort((a: any, b: any) => {
        // First, sort by the group they reached (higher group number = finals)
        if (b.finalMatchGroup !== a.finalMatchGroup) {
          return b.finalMatchGroup - a.finalMatchGroup;
        }
        
        // If same group, check if they won or lost their final match
        if (a.wonFinalMatch !== b.wonFinalMatch) {
          return a.wonFinalMatch ? -1 : 1;
        }
        
        // If same group and same outcome, sort by round reached
        if (b.finalMatchRound !== a.finalMatchRound) {
          return b.finalMatchRound - a.finalMatchRound;
        }
        
        // Finally by total wins
        if (b.wins !== a.wins) {
          return b.wins - a.wins;
        }
        
        // Finally by losses (fewer = better)
        return a.losses - b.losses;
      });
    
    standings.forEach((p: any, index: number) => {
      placements.push({
        placement: index + 1,
        participant_id: p.id,
        participant_name: p.name,
        wins: p.wins,
        losses: p.losses
      });
    });
    
  } else {
    // For single elimination, simpler logic
    const participantStats = new Map();
    
    participants.forEach((p: any) => {
      if (!p.name) return;
      participantStats.set(p.id, {
        id: p.id,
        name: p.name,
        wins: 0,
        losses: 0
      });
    });
    
    matches.forEach((match: any) => {
      const p1 = participantStats.get(match.opponent1?.id);
      const p2 = participantStats.get(match.opponent2?.id);
      
      if (match.opponent1?.result === 'win' && p1 && p2) {
        p1.wins++;
        p2.losses++;
      } else if (match.opponent2?.result === 'win' && p1 && p2) {
        p2.wins++;
        p1.losses++;
      }
    });
    
    const standings = Array.from(participantStats.values())
      .sort((a: any, b: any) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        return a.losses - b.losses;
      });
    
    standings.forEach((p: any, index: number) => {
      placements.push({
        placement: index + 1,
        participant_id: p.id,
        participant_name: p.name,
        wins: p.wins,
        losses: p.losses
      });
    });
  }
  
  return placements;
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
  console.log(`📊 API verfügbar unter http://localhost:${PORT}/api`);
});

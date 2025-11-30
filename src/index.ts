import { BracketsManager } from 'brackets-manager';
import { JsonDatabase } from 'brackets-json-db';

async function main() {
  // Initialize storage and manager
  const storage = new JsonDatabase();
  const manager = new BracketsManager(storage);

  console.log('🏆 Tournament Bracket Manager Demo\n');

  // Example 1: Create a single elimination tournament
  console.log('--- Creating Single Elimination Tournament ---');
  try {
    await manager.create.stage({
      tournamentId: 1,
      name: 'Single Elimination',
      type: 'single_elimination',
      seeding: [
        'Team Alpha',
        'Team Beta',
        'Team Gamma',
        'Team Delta',
        'Team Epsilon',
        'Team Zeta',
        'Team Eta',
        'Team Theta'
      ],
      settings: {
        seedOrdering: ['natural'],
      }
    });
    console.log('✓ Single Elimination stage created successfully\n');
  } catch (error) {
    console.error('Error creating single elimination:', error);
  }

  // Example 2: Create a double elimination tournament
  console.log('--- Creating Double Elimination Tournament ---');
  try {
    await manager.create.stage({
      tournamentId: 2,
      name: 'Double Elimination',
      type: 'double_elimination',
      seeding: [
        'Player 1',
        'Player 2',
        'Player 3',
        'Player 4'
      ],
      settings: {
        grandFinal: 'double', // Winner bracket winner needs to lose twice
      }
    });
    console.log('✓ Double Elimination stage created successfully\n');
  } catch (error) {
    console.error('Error creating double elimination:', error);
  }

  // Example 3: Update match results
  console.log('--- Updating Match Results ---');
  try {
    // Get all matches for tournament 1
    const matches = await storage.select('match', { stage_id: 0 });
    
    if (matches && matches.length > 0) {
      // Update the first match
      const firstMatch = matches[0] as any;
      await manager.update.match({
        id: firstMatch.id,
        opponent1: { score: 16, result: 'win' },
        opponent2: { score: 12 },
      });
      console.log(`✓ Match ${firstMatch.id} updated: Team wins 16-12\n`);
    }
  } catch (error) {
    console.error('Error updating match:', error);
  }

  // Example 4: Create a round-robin tournament
  console.log('--- Creating Round-Robin Tournament ---');
  try {
    await manager.create.stage({
      tournamentId: 3,
      name: 'Round Robin',
      type: 'round_robin',
      seeding: [
        'Team A',
        'Team B',
        'Team C',
        'Team D'
      ],
      settings: {
        groupCount: 1, // Single group
        size: 4,
      }
    });
    console.log('✓ Round-Robin stage created successfully\n');
  } catch (error) {
    console.error('Error creating round-robin:', error);
  }

  // Display all stages
  console.log('--- All Stages ---');
  try {
    const stages = await storage.select('stage');
    stages?.forEach((stage: any) => {
      console.log(`- ${stage.name} (Tournament ${stage.tournament_id}, Type: ${stage.type})`);
    });
  } catch (error) {
    console.error('Error fetching stages:', error);
  }

  console.log('\n✨ Demo completed!');
  console.log('📄 Check the database.json file for the complete tournament data');
}

// Run the main function
main().catch(console.error);

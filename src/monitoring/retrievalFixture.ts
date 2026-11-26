import { parseEvidenceFile, toEvidenceSourceRecords } from '../services/evidenceIntakeService';
import billing from './fixtures/retrieval-v1/billing.csv?raw';
import forecast from './fixtures/retrieval-v1/forecast.html?raw';
import background from './fixtures/retrieval-v1/background.html?raw';
import { retrievalReference } from './retrievalReference';

export const loadRetrievalFixture = async () => {
  const files = [
    new File([billing], 'billing.csv', { type: 'text/csv' }),
    new File([forecast], 'forecast.html', { type: 'text/html' }),
    new File([background], 'background.html', { type: 'text/html' }),
  ];
  const sources = toEvidenceSourceRecords(await Promise.all(files.map(parseEvidenceFile)));
  if (!sources.every((source, index) => source.acquisition?.original_sha256 === retrievalReference.sourceHashes[index])) {
    throw new Error('GOLDEN_STANDARD_FIXTURE_MISMATCH');
  }
  return sources;
};

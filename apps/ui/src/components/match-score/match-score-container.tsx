import * as React from 'react';
import { MatchScoreButton } from './match-score-button';
import { MatchScoreModal } from './match-score-modal';
import { useMatchScore } from '@/hooks/use-match-score';
import type { Item } from '@/lib/item-api';

export interface MatchScoreContainerProps {
  localItem: Item | null;
  networkItem: Item;
  localItemName: string;
  networkItemName: string;
  onProceed?: () => void;
}

export function MatchScoreContainer({
  localItem,
  networkItem,
  localItemName,
  networkItemName,
  onProceed,
}: MatchScoreContainerProps) {
  const [isModalOpen, setIsModalOpen] = React.useState(false);
  
  const {
    score,
    isLoading,
    error,
    calculate,
    recalculate,
  } = useMatchScore({
    localItem,
    networkItem,
  });

  const handleCalculate = React.useCallback(() => {
    void calculate();
  }, [calculate]);

  const handleViewDetails = React.useCallback(() => {
    setIsModalOpen(true);
  }, []);

  const handleCloseModal = React.useCallback(() => {
    setIsModalOpen(false);
  }, []);

  const handleRecalculate = React.useCallback(() => {
    void recalculate();
  }, [recalculate]);

  return (
    <>
      <MatchScoreButton
        localItem={localItem}
        networkItem={networkItem}
        score={score}
        isLoading={isLoading}
        error={error}
        onCalculate={handleCalculate}
        onViewDetails={handleViewDetails}
        disabled={!localItem}
      />
      <MatchScoreModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        score={score}
        isLoading={isLoading}
        localItemName={localItemName}
        networkItemName={networkItemName}
        onRecalculate={handleRecalculate}
        onProceed={onProceed}
      />
    </>
  );
}

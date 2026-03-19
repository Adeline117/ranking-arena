-- Wilson score lower bound for comment ranking
-- https://www.evanmiller.org/how-not-to-sort-by-average-rating.html
-- Used to rank comments by "Best" (Reddit-style) instead of raw like count.
CREATE OR REPLACE FUNCTION wilson_score_lower(ups integer, downs integer)
RETURNS double precision AS $$
DECLARE
  n integer;
  z double precision := 1.96; -- 95% confidence
  phat double precision;
BEGIN
  n := ups + downs;
  IF n = 0 THEN RETURN 0; END IF;
  phat := ups::double precision / n;
  RETURN (phat + z*z/(2*n) - z * sqrt((phat*(1-phat)+z*z/(4*n))/n)) / (1+z*z/n);
END;
$$ LANGUAGE plpgsql IMMUTABLE;
